const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

const ADMIN_COOKIE = "shga_admin";
const ADMIN_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const DEFAULT_INLINE_TEXT_LIMIT = 1000;
const DEFAULT_PANEL_TEXT_LIMIT = 6000;
const DEFAULT_DAILY_QUOTA = 200;
const DEFAULT_MINUTE_QUOTA = 20;
const TOKEN_PREFIX = "ga_";

let schemaReadyPromise = null;

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: JSON_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      return handleAdminRequest(request, env);
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        service: "self-hosted-grammar-worker",
        database: Boolean(env.DB),
        auth: Boolean(env.DB || env.GRAMMAR_API_KEY),
        aiProvider: getAiProvider(env),
        storeQaPreviews: String(env.STORE_QA_PREVIEWS || "").toLowerCase() === "true"
      });
    }

    if (request.method === "GET" && url.pathname === "/qa/checks") {
      const admin = await requireAdminAccess(request, env);
      if (!admin.ok) {
        return json({ error: admin.error }, admin.status);
      }

      return getQaChecks(url, env);
    }

    if (request.method === "POST" && url.pathname === "/grammar/check") {
      return handleGrammarCheck(request, env, ctx);
    }

    if ((request.method === "GET" || request.method === "HEAD") && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return json({ error: "Not found" }, 404);
  }
};

async function handleGrammarCheck(request, env, ctx) {
  const access = await requireGrammarAccess(request, env);
  if (!access.ok) {
    return json({ error: access.error }, access.status);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    await recordUsageEvent(env, access, {
      scope: "unknown",
      mode: "grammar",
      inputLength: 0,
      success: false,
      error: "Invalid JSON body"
    });
    return json({ error: "Invalid JSON body" }, 400);
  }

  const text = String(payload.text || "").trim();
  const scope = payload.scope === "inline" ? "inline" : "panel";
  const limit = scope === "inline" ? getInlineTextLimit(env) : getPanelTextLimit(env);

  if (!text) {
    await recordUsageEvent(env, access, {
      scope,
      mode: safeString(payload.mode, "grammar"),
      inputLength: 0,
      success: false,
      error: "Missing text"
    });
    return json({ error: "Missing text" }, 400);
  }

  if (text.length > limit) {
    await recordUsageEvent(env, access, {
      scope,
      mode: safeString(payload.mode, "grammar"),
      inputLength: text.length,
      success: false,
      error: "Text is too long"
    });
    return json({ error: `Text is too long for ${scope} checks. Limit is ${limit} characters.` }, 413);
  }

  const quotaError = await checkQuota(env, access);
  if (quotaError) {
    await recordUsageEvent(env, access, {
      scope,
      mode: safeString(payload.mode, "grammar"),
      inputLength: text.length,
      success: false,
      error: quotaError
    });
    return json({ error: quotaError }, 429);
  }

  try {
    const mode = safeString(payload.mode, "grammar");
    const language = safeString(payload.language, "en");
    const pageUrl = safeString(payload.pageUrl, "");
    const result = await checkText({
      text,
      mode,
      language,
      pageUrl,
      scope,
      env
    });

    ctx.waitUntil(Promise.all([
      recordGrammarCheck(env, {
        mode,
        language,
        pageUrl,
        inputText: text,
        correctedText: result.correctedText,
        suggestionCount: Math.max(result.issues?.length || 0, result.suggestions?.length || 0),
        success: true,
        error: ""
      }),
      recordUsageEvent(env, access, {
        scope,
        mode,
        inputLength: text.length,
        success: true,
        error: ""
      }),
      markTokenUsed(env, access)
    ]));

    return json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Grammar check failed";
    ctx.waitUntil(Promise.all([
      recordGrammarCheck(env, {
        mode: safeString(payload.mode, "grammar"),
        language: safeString(payload.language, "en"),
        pageUrl: safeString(payload.pageUrl, ""),
        inputText: text,
        correctedText: "",
        suggestionCount: 0,
        success: false,
        error: message
      }),
      recordUsageEvent(env, access, {
        scope,
        mode: safeString(payload.mode, "grammar"),
        inputLength: text.length,
        success: false,
        error: message
      }),
      markTokenUsed(env, access)
    ]));

    return json({ error: message }, 500);
  }
}

async function requireGrammarAccess(request, env) {
  const token = getBearerToken(request);
  if (!token) {
    return { ok: false, status: 401, error: "Missing Worker access token" };
  }

  const dbAccess = await getDbTokenAccess(token, env);
  if (dbAccess.ok) {
    return dbAccess;
  }

  if (env.GRAMMAR_API_KEY && await secretsEqual(token, env.GRAMMAR_API_KEY)) {
    return {
      ok: true,
      kind: "shared",
      userId: null,
      tokenId: null,
      email: "self-hosted-token",
      role: "user",
      quotaDaily: 0,
      quotaMinute: 0
    };
  }

  return dbAccess.status
    ? dbAccess
    : { ok: false, status: 401, error: "Worker access token is invalid, expired, or revoked" };
}

async function getDbTokenAccess(token, env) {
  if (!env.DB) {
    return { ok: false };
  }

  try {
    await ensureAuthSchema(env);
    const tokenHash = await hashToken(token, env);
    const row = await env.DB.prepare(
      `SELECT t.id AS token_id,
              t.user_id,
              t.status AS token_status,
              t.expires_at,
              t.token_prefix,
              u.email,
              u.role,
              u.status AS user_status,
              u.quota_daily,
              u.quota_minute
         FROM api_tokens t
         JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = ?
        LIMIT 1`
    )
      .bind(tokenHash)
      .first();

    if (!row) {
      return { ok: false };
    }

    if (row.token_status !== "active" || row.user_status !== "active") {
      return { ok: false, status: 401, error: "Worker access token is revoked or disabled" };
    }

    if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
      return { ok: false, status: 401, error: "Worker access token is expired" };
    }

    return {
      ok: true,
      kind: "db-token",
      userId: row.user_id,
      tokenId: row.token_id,
      email: row.email,
      role: row.role || "user",
      quotaDaily: Number(row.quota_daily) || 0,
      quotaMinute: Number(row.quota_minute) || 0
    };
  } catch (error) {
    console.warn("Token auth failed", error);
    return { ok: false };
  }
}

async function requireAdminAccess(request, env) {
  const session = await getAdminSession(request, env);
  if (session) {
    return { ok: true, kind: "session", adminEmail: session.admin_email };
  }

  const token = getBearerToken(request);
  if (token && env.GRAMMAR_API_KEY && await secretsEqual(token, env.GRAMMAR_API_KEY)) {
    return { ok: true, kind: "shared-token", adminEmail: "shared-token" };
  }

  return { ok: false, status: 401, error: "Admin login required" };
}

async function checkQuota(env, access) {
  if (!env.DB || access.kind !== "db-token" || !access.userId) {
    return "";
  }

  await ensureAuthSchema(env);

  const minuteQuota = Number(access.quotaMinute) || 0;
  const dailyQuota = Number(access.quotaDaily) || 0;

  if (minuteQuota > 0) {
    const minute = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM usage_events WHERE user_id = ? AND created_at >= datetime('now', '-1 minute')"
    )
      .bind(access.userId)
      .first();
    if (Number(minute?.count || 0) >= minuteQuota) {
      return "Minute usage limit reached. Try again shortly.";
    }
  }

  if (dailyQuota > 0) {
    const daily = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM usage_events WHERE user_id = ? AND created_at >= datetime('now', '-1 day')"
    )
      .bind(access.userId)
      .first();
    if (Number(daily?.count || 0) >= dailyQuota) {
      return "Daily usage limit reached.";
    }
  }

  return "";
}

async function markTokenUsed(env, access) {
  if (!env.DB || access.kind !== "db-token" || !access.tokenId) {
    return;
  }

  try {
    await env.DB.prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?")
      .bind(access.tokenId)
      .run();
  } catch (error) {
    console.warn("Failed to update token usage time", error);
  }
}

async function recordUsageEvent(env, access, event) {
  if (!env.DB || access.kind !== "db-token") {
    return;
  }

  try {
    await ensureAuthSchema(env);
    await env.DB.prepare(
      `INSERT INTO usage_events (
          user_id,
          token_id,
          scope,
          mode,
          input_length,
          success,
          error
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        access.userId,
        access.tokenId,
        safeString(event.scope, "panel"),
        safeString(event.mode, "grammar"),
        Number(event.inputLength) || 0,
        event.success ? 1 : 0,
        safeString(event.error, "").slice(0, 300)
      )
      .run();
  } catch (error) {
    console.warn("Failed to record usage event", error);
  }
}

async function handleAdminRequest(request, env) {
  if (!env.DB) {
    return html(adminShell("Admin unavailable", "<p>D1 database binding is required for the admin dashboard.</p>"), 500);
  }

  await ensureAuthSchema(env);

  const url = new URL(request.url);

  if (url.pathname === "/admin/login" && request.method === "GET") {
    return html(renderLoginPage(env));
  }

  if (url.pathname === "/admin/login" && request.method === "POST") {
    return handleAdminLogin(request, env);
  }

  const session = await getAdminSession(request, env);
  if (!session) {
    return redirect("/admin/login");
  }

  if (url.pathname === "/admin/logout" && request.method === "POST") {
    await deleteAdminSession(request, env);
    return redirect("/admin/login", {
      "Set-Cookie": buildSessionCookie("", request, 0)
    });
  }

  if ((url.pathname === "/admin" || url.pathname === "/admin/") && request.method === "GET") {
    return html(await renderAdminDashboard(env, session, {
      notice: url.searchParams.get("notice") || "",
      error: url.searchParams.get("error") || ""
    }));
  }

  if (url.pathname === "/admin/ai-settings" && request.method === "POST") {
    return handleUpdateAiSettings(request, env);
  }

  if (url.pathname === "/admin/invite" && request.method === "POST") {
    return handleQuickInvite(request, env);
  }

  if (url.pathname === "/admin/users" && request.method === "POST") {
    return handleCreateUser(request, env, session);
  }

  if (url.pathname === "/admin/users/update" && request.method === "POST") {
    return handleUpdateUser(request, env);
  }

  if (url.pathname === "/admin/tokens" && request.method === "POST") {
    return handleCreateToken(request, env, session);
  }

  if (url.pathname === "/admin/tokens/copy" && request.method === "POST") {
    return handleCopyToken(request, env);
  }

  if (url.pathname === "/admin/tokens/revoke" && request.method === "POST") {
    return handleRevokeToken(request, env);
  }

  return html(adminShell("Not found", "<p>Admin route not found.</p>"), 404);
}

async function handleAdminLogin(request, env) {
  const form = await request.formData();
  const email = safeFormString(form, "email").toLowerCase();
  const password = safeFormString(form, "password");

  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD_HASH || !env.SESSION_SECRET) {
    return html(renderLoginPage(env, "Set ADMIN_EMAIL, ADMIN_PASSWORD_HASH, and SESSION_SECRET before using admin login."), 500);
  }

  if (email !== String(env.ADMIN_EMAIL).trim().toLowerCase()) {
    return html(renderLoginPage(env, "Invalid admin email or password."), 401);
  }

  const validPassword = await verifyPassword(password, env.ADMIN_PASSWORD_HASH);
  if (!validPassword) {
    return html(renderLoginPage(env, "Invalid admin email or password."), 401);
  }

  const sessionToken = createSecretToken(32);
  const sessionHash = await hashSession(sessionToken, env);
  await env.DB.prepare(
    `INSERT INTO admin_sessions (admin_email, session_hash, expires_at)
     VALUES (?, ?, datetime('now', ?))`
  )
    .bind(email, sessionHash, `+${ADMIN_SESSION_TTL_SECONDS} seconds`)
    .run();

  return redirect("/admin", {
    "Set-Cookie": buildSessionCookie(sessionToken, request, ADMIN_SESSION_TTL_SECONDS)
  });
}

async function handleUpdateAiSettings(request, env) {
  const wantsJson = wantsJsonResponse(request);
  const form = await request.formData();
  const provider = normalizeAiProvider(safeFormString(form, "provider"));
  const apiUrl = normalizeApiUrlForProvider(provider, safeFormString(form, "api_url"));
  const model = normalizeModelForProvider(provider, safeFormString(form, "model"));
  const apiKey = safeFormString(form, "api_key");

  if (provider === "custom" && !apiUrl) {
    if (wantsJson) {
      return json({ ok: false, error: "Custom provider requires an API URL." }, 400);
    }
    return redirect("/admin?error=Custom%20provider%20requires%20an%20API%20URL");
  }

  if (!apiKey) {
    if (wantsJson) {
      return json({ ok: false, error: "API key is required." }, 400);
    }
    return redirect("/admin?error=API%20key%20is%20required");
  }

  await env.DB.prepare(
    `INSERT INTO ai_settings (id, provider, api_url, model)
     VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       provider = ?,
       api_url = ?,
       model = ?,
       updated_at = datetime('now')`
  )
    .bind(provider, apiUrl, model, provider, apiUrl, model)
    .run();

  await env.DB.prepare("UPDATE ai_settings SET api_key_ciphertext = ?, updated_at = datetime('now') WHERE id = 1")
    .bind(await encryptSecret(apiKey, env))
    .run();

  const connection = await testAiConnection({
    provider,
    apiKey,
    apiUrl,
    model,
    source: "admin settings"
  });
  if (connection.workingApiUrl && connection.workingApiUrl !== apiUrl) {
    await env.DB.prepare("UPDATE ai_settings SET api_url = ?, updated_at = datetime('now') WHERE id = 1")
      .bind(connection.workingApiUrl)
      .run();
  }
  await saveAiConnectionStatus(env, connection);

  if (wantsJson) {
    const settings = await getAiSettingsForDashboard(env);
    return json({
      ok: true,
      notice: connection.ok ? "Saved. Provider connected." : "Saved. Provider test failed.",
      provider: settings.provider,
      apiUrl: settings.apiUrl,
      model: settings.model,
      apiKey: settings.apiKey,
      hasApiKey: settings.hasApiKey,
      readyStatus: settings.readyStatus,
      connectionStatus: settings.connectionStatus,
      connectionMessage: settings.connectionMessage,
      connectionCheckedAt: settings.connectionCheckedAt,
      source: settings.source
    });
  }

  return redirect(`/admin?notice=${encodeURIComponent(connection.ok ? "AI settings saved. Provider connected." : "AI settings saved. Provider test failed.")}`);
}

async function handleCreateUser(request, env) {
  const form = await request.formData();
  const email = safeFormString(form, "email").toLowerCase();
  const role = safeFormString(form, "role") === "admin" ? "admin" : "user";
  const status = safeFormString(form, "status") === "disabled" ? "disabled" : "active";
  const quotaDaily = parsePositiveInt(safeFormString(form, "quota_daily"), DEFAULT_DAILY_QUOTA);
  const quotaMinute = parsePositiveInt(safeFormString(form, "quota_minute"), DEFAULT_MINUTE_QUOTA);

  if (!email || !email.includes("@")) {
    return redirect("/admin?error=Invalid%20email");
  }

  try {
    await env.DB.prepare(
      `INSERT INTO users (email, role, status, quota_daily, quota_minute)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(email, role, status, quotaDaily, quotaMinute)
      .run();
    return redirect("/admin?notice=User%20created");
  } catch (error) {
    return redirect(`/admin?error=${encodeURIComponent(error instanceof Error ? error.message : "Could not create user")}`);
  }
}

async function handleQuickInvite(request, env) {
  const form = await request.formData();
  const email = safeFormString(form, "email").toLowerCase();
  const quotaDaily = parsePositiveInt(safeFormString(form, "quota_daily"), DEFAULT_DAILY_QUOTA);
  const quotaMinute = parsePositiveInt(safeFormString(form, "quota_minute"), DEFAULT_MINUTE_QUOTA);
  const expiresDays = Number(safeFormString(form, "expires_days"));

  if (!email || !email.includes("@")) {
    return redirect("/admin?error=Invalid%20email");
  }

  try {
    let user = await env.DB.prepare("SELECT id, email FROM users WHERE email = ?")
      .bind(email)
      .first();

    if (user) {
      await env.DB.prepare(
        `UPDATE users
            SET status = 'active',
                role = 'user',
                quota_daily = ?,
                quota_minute = ?,
                updated_at = datetime('now')
          WHERE id = ?`
      )
        .bind(quotaDaily, quotaMinute, user.id)
        .run();
    } else {
      await env.DB.prepare(
        `INSERT INTO users (email, role, status, quota_daily, quota_minute)
         VALUES (?, 'user', 'active', ?, ?)`
      )
        .bind(email, quotaDaily, quotaMinute)
        .run();
      user = await env.DB.prepare("SELECT id, email FROM users WHERE email = ?")
        .bind(email)
        .first();
    }

    const token = await createAccessToken(env, {
      userId: user.id,
      name: "Chrome extension",
      expiresDays
    });

    return html(await renderAdminDashboard(env, { admin_email: env.ADMIN_EMAIL }, {
      notice: "User and token are ready. Copy the token now; it will not be shown again.",
      newToken: token,
      newTokenUser: user.email
    }));
  } catch (error) {
    return redirect(`/admin?error=${encodeURIComponent(error instanceof Error ? error.message : "Could not create invite")}`);
  }
}

async function handleUpdateUser(request, env) {
  const form = await request.formData();
  const id = Number(safeFormString(form, "id"));
  const role = safeFormString(form, "role") === "admin" ? "admin" : "user";
  const status = safeFormString(form, "status") === "disabled" ? "disabled" : "active";
  const quotaDaily = parsePositiveInt(safeFormString(form, "quota_daily"), DEFAULT_DAILY_QUOTA);
  const quotaMinute = parsePositiveInt(safeFormString(form, "quota_minute"), DEFAULT_MINUTE_QUOTA);

  if (!Number.isInteger(id) || id <= 0) {
    return redirect("/admin?error=Invalid%20user");
  }

  await env.DB.prepare(
    `UPDATE users
        SET role = ?,
            status = ?,
            quota_daily = ?,
            quota_minute = ?,
            updated_at = datetime('now')
      WHERE id = ?`
  )
    .bind(role, status, quotaDaily, quotaMinute, id)
    .run();
  return redirect("/admin?notice=User%20updated");
}

async function handleCreateToken(request, env) {
  const form = await request.formData();
  const userId = Number(safeFormString(form, "user_id"));
  const name = safeFormString(form, "name") || "Chrome extension";
  const expiresDays = Number(safeFormString(form, "expires_days"));

  if (!Number.isInteger(userId) || userId <= 0) {
    return redirect("/admin?error=Invalid%20user");
  }

  const user = await env.DB.prepare("SELECT id, email FROM users WHERE id = ?").bind(userId).first();
  if (!user) {
    return redirect("/admin?error=User%20not%20found");
  }

  const token = await createAccessToken(env, {
    userId,
    name,
    expiresDays
  });

  return html(await renderAdminDashboard(env, { admin_email: env.ADMIN_EMAIL }, {
    notice: "Token created. Copy it now; it will not be shown again.",
    newToken: token,
    newTokenUser: user.email
  }));
}

async function createAccessToken(env, { userId, name, expiresDays }) {
  const token = `${TOKEN_PREFIX}${createSecretToken(32)}`;
  const tokenHash = await hashToken(token, env);
  const tokenPrefix = token.slice(0, 14);
  const tokenCiphertext = await encryptToken(token, env);
  const expiresAt = Number.isFinite(expiresDays) && expiresDays > 0
    ? `datetime('now', '+${Math.floor(expiresDays)} days')`
    : "NULL";

  await env.DB.prepare(
    `INSERT INTO api_tokens (user_id, name, token_prefix, token_hash, token_ciphertext, expires_at)
     VALUES (?, ?, ?, ?, ?, ${expiresAt})`
  )
    .bind(userId, name || "Chrome extension", tokenPrefix, tokenHash, tokenCiphertext)
    .run();

  return token;
}

async function handleCopyToken(request, env) {
  const form = await request.formData();
  const tokenId = Number(safeFormString(form, "id"));
  if (!Number.isInteger(tokenId) || tokenId <= 0) {
    return redirect("/admin?error=Invalid%20token");
  }

  const tokenRow = await env.DB.prepare(
    `SELECT t.id,
            t.token_ciphertext,
            t.status,
            t.expires_at,
            u.email
       FROM api_tokens t
       JOIN users u ON u.id = t.user_id
      WHERE t.id = ?
      LIMIT 1`
  )
    .bind(tokenId)
    .first();

  if (!tokenRow) {
    return redirect("/admin?error=Token%20not%20found");
  }

  if (tokenRow.status !== "active") {
    return redirect("/admin?error=Only%20active%20tokens%20can%20be%20copied");
  }

  if (tokenRow.expires_at && Date.parse(tokenRow.expires_at) <= Date.now()) {
    return redirect("/admin?error=Token%20is%20expired");
  }

  if (!tokenRow.token_ciphertext) {
    return redirect("/admin?error=This%20older%20token%20was%20not%20stored%20for%20copying.%20Create%20a%20new%20token.");
  }

  const token = await decryptToken(tokenRow.token_ciphertext, env);
  return html(await renderAdminDashboard(env, { admin_email: env.ADMIN_EMAIL }, {
    notice: "Token ready to copy.",
    newToken: token,
    newTokenUser: tokenRow.email
  }));
}

async function handleRevokeToken(request, env) {
  const form = await request.formData();
  const tokenId = Number(safeFormString(form, "id"));
  if (!Number.isInteger(tokenId) || tokenId <= 0) {
    return redirect("/admin?error=Invalid%20token");
  }

  await env.DB.prepare("UPDATE api_tokens SET status = 'revoked' WHERE id = ?")
    .bind(tokenId)
    .run();
  return redirect("/admin?notice=Token%20revoked");
}

async function getAdminSession(request, env) {
  if (!env.DB || !env.SESSION_SECRET) {
    return null;
  }

  const token = getCookie(request, ADMIN_COOKIE);
  if (!token) {
    return null;
  }

  try {
    await ensureAuthSchema(env);
    const sessionHash = await hashSession(token, env);
    const session = await env.DB.prepare(
      "SELECT id, admin_email, expires_at FROM admin_sessions WHERE session_hash = ? LIMIT 1"
    )
      .bind(sessionHash)
      .first();

    if (!session || Date.parse(session.expires_at) <= Date.now()) {
      return null;
    }

    return session;
  } catch (error) {
    console.warn("Admin session check failed", error);
    return null;
  }
}

async function deleteAdminSession(request, env) {
  const token = getCookie(request, ADMIN_COOKIE);
  if (!token || !env.DB || !env.SESSION_SECRET) {
    return;
  }

  const sessionHash = await hashSession(token, env);
  await env.DB.prepare("DELETE FROM admin_sessions WHERE session_hash = ?")
    .bind(sessionHash)
    .run();
}

async function renderAdminDashboard(env, session, flash = {}) {
  const [users, tokens, usage, aiSettings] = await Promise.all([
    env.DB.prepare(
      `SELECT u.id,
              u.email,
              u.role,
              u.status,
              u.quota_daily,
              u.quota_minute,
              u.created_at,
              COUNT(t.id) AS token_count
         FROM users u
         LEFT JOIN api_tokens t ON t.user_id = u.id AND t.status = 'active'
        GROUP BY u.id
        ORDER BY u.id DESC
        LIMIT 100`
    ).all(),
    env.DB.prepare(
      `SELECT t.id,
              t.name,
              t.token_prefix,
              CASE WHEN t.token_ciphertext IS NULL OR t.token_ciphertext = '' THEN 0 ELSE 1 END AS can_copy,
              t.status,
              t.expires_at,
              t.last_used_at,
              t.created_at,
              u.email
         FROM api_tokens t
         JOIN users u ON u.id = t.user_id
        ORDER BY t.id DESC
        LIMIT 100`
    ).all(),
    env.DB.prepare(
      `SELECT e.created_at,
              e.scope,
              e.mode,
              e.input_length,
              e.success,
              e.error,
              u.email,
              t.token_prefix
         FROM usage_events e
         LEFT JOIN users u ON u.id = e.user_id
         LEFT JOIN api_tokens t ON t.id = e.token_id
        ORDER BY e.id DESC
        LIMIT 50`
    ).all(),
    getAiSettingsForDashboard(env)
  ]);

  const health = {
    aiProvider: aiSettings.provider,
    aiConfigured: aiSettings.hasRuntimeKey,
    aiSource: aiSettings.source,
    fallbackToken: Boolean(env.GRAMMAR_API_KEY),
    inlineLimit: getInlineTextLimit(env),
    panelLimit: getPanelTextLimit(env),
    previews: String(env.STORE_QA_PREVIEWS || "").toLowerCase() === "true"
  };

  const userOptions = (users.results || [])
    .map((user) => `<option value="${user.id}">${escapeHtml(user.email)}</option>`)
    .join("");

  const body = `
    ${flash.error ? `<div class="alert error">${escapeHtml(flash.error)}</div>` : ""}
    ${flash.notice ? `<div class="alert">${escapeHtml(flash.notice)}</div>` : ""}
    ${flash.newToken ? `
      <section class="secret-box">
        <h2>New access token</h2>
        <p>User: ${escapeHtml(flash.newTokenUser || "")}</p>
        <div class="copy-row">
          <code id="tokenValue">${escapeHtml(flash.newToken)}</code>
          <button class="secondary" type="button" data-copy-token>Copy token</button>
        </div>
      </section>
    ` : ""}

    <section class="ai-settings-card">
      <div>
        <h2>AI API settings</h2>
        <p>Choose a provider, paste its API key, then save.</p>
      </div>
      <form class="ai-settings-form" method="post" action="/admin/ai-settings" data-ai-settings-form>
        <label>Provider
          <select name="provider" data-ai-provider>
            <option value="openai" data-default-url="${escapeHtml(getDefaultApiUrl("openai"))}" data-default-model="${escapeHtml(getDefaultModel("openai"))}"${aiSettings.provider === "openai" ? " selected" : ""}>OpenAI</option>
            <option value="qwen" data-default-url="${escapeHtml(getDefaultApiUrl("qwen"))}" data-default-model="${escapeHtml(getDefaultModel("qwen"))}"${aiSettings.provider === "qwen" ? " selected" : ""}>Qwen / DashScope</option>
            <option value="gemini" data-default-url="" data-default-model="${escapeHtml(getDefaultModel("gemini"))}"${aiSettings.provider === "gemini" ? " selected" : ""}>Gemini</option>
            <option value="custom" data-default-url="" data-default-model="${escapeHtml(getDefaultModel("custom"))}"${aiSettings.provider === "custom" ? " selected" : ""}>Other OpenAI-compatible</option>
          </select>
        </label>
        <label>API URL
          <input name="api_url" type="url" value="${escapeHtml(aiSettings.apiUrl || "")}" placeholder="Optional for OpenAI, Qwen, Gemini" data-ai-api-url>
        </label>
        <label>Model
          <input name="model" value="${escapeHtml(aiSettings.model || "")}" placeholder="qwen-plus, gemini-2.5-flash, gpt-4.1-mini" data-ai-model>
        </label>
        <label>API key
          <input name="api_key" type="text" autocomplete="off" spellcheck="false" required value="${escapeHtml(aiSettings.apiKey || "")}" placeholder="Paste API key" data-ai-api-key>
        </label>
        <button type="submit" data-ai-submit>Save & test</button>
      </form>
      <p class="settings-note" data-ai-settings-note>
        API key: <strong data-ai-key-status>${aiSettings.hasApiKey ? "saved" : "required"}</strong>
        <span aria-hidden="true">·</span>
        Provider: <strong data-ai-connection-status class="status-${escapeHtml(aiSettings.connectionStatus)}">${escapeHtml(aiSettings.connectionLabel)}</strong>
        <span aria-hidden="true">·</span>
        Ready: <strong data-ai-ready-status>${escapeHtml(aiSettings.readyStatus)}</strong>
        ${aiSettings.connectionCheckedAt ? `<span data-ai-checked-at>· Checked: ${escapeHtml(aiSettings.connectionCheckedAt)}</span>` : `<span data-ai-checked-at></span>`}
      </p>
      <p class="save-status ${aiSettings.connectionStatus === "failed" ? "error" : ""}" role="status" aria-live="polite" data-ai-save-status>
        ${aiSettings.connectionMessage ? escapeHtml(aiSettings.connectionMessage) : ""}
      </p>
    </section>

    <section class="quick-card">
      <div>
        <p class="eyebrow">Fast setup</p>
        <h2>Quick invite</h2>
        <p>Create or reactivate a user and generate their Chrome extension token in one step.</p>
      </div>
      <form class="quick-form" method="post" action="/admin/invite">
        <label>User email <input name="email" type="email" required placeholder="user@example.com"></label>
        <label>Daily quota <input name="quota_daily" type="number" min="0" value="${DEFAULT_DAILY_QUOTA}"></label>
        <label>Minute quota <input name="quota_minute" type="number" min="0" value="${DEFAULT_MINUTE_QUOTA}"></label>
        <label>Expires in days <input name="expires_days" type="number" min="1" placeholder="Blank means no expiry"></label>
        <button type="submit">Create token</button>
      </form>
    </section>

    <details class="admin-details">
      <summary>Advanced user and token tools</summary>
      <section class="grid two">
        <article>
        <h2>Create user</h2>
        <form method="post" action="/admin/users">
          <label>Email <input name="email" type="email" required placeholder="user@example.com"></label>
          <div class="form-grid">
            <label>Role
              <select name="role">
                <option value="user">User</option>
                <option value="admin">Admin label</option>
              </select>
            </label>
            <label>Status
              <select name="status">
                <option value="active">Active</option>
                <option value="disabled">Disabled</option>
              </select>
            </label>
          </div>
          <div class="form-grid">
            <label>Daily quota <input name="quota_daily" type="number" min="0" value="${DEFAULT_DAILY_QUOTA}"></label>
            <label>Minute quota <input name="quota_minute" type="number" min="0" value="${DEFAULT_MINUTE_QUOTA}"></label>
          </div>
          <button type="submit">Create user</button>
        </form>
        </article>

        <article>
        <h2>Create token</h2>
        <form method="post" action="/admin/tokens">
          <label>User
            <select name="user_id" required>${userOptions}</select>
          </label>
          <label>Name <input name="name" value="Chrome extension"></label>
          <label>Expires in days <input name="expires_days" type="number" min="1" placeholder="Blank means no expiry"></label>
          <button type="submit">Generate token</button>
        </form>
        </article>
      </section>
    </details>

    <section>
      <h2>Worker health</h2>
      <div class="metrics">
        <span>AI provider <strong data-health-provider>${escapeHtml(health.aiProvider)}</strong></span>
        <span>AI key <strong data-health-key>${health.aiConfigured ? "configured" : "demo fallback"}</strong></span>
        <span>AI status <strong data-health-connection>${escapeHtml(aiSettings.connectionLabel)}</strong></span>
        <span>Shared token <strong>${health.fallbackToken ? "enabled" : "off"}</strong></span>
        <span>Inline limit <strong>${health.inlineLimit}</strong></span>
        <span>Panel limit <strong>${health.panelLimit}</strong></span>
        <span>QA previews <strong>${health.previews ? "on" : "off"}</strong></span>
      </div>
    </section>

    <section>
      <h2>Users</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Daily</th><th>Minute</th><th>Tokens</th><th></th></tr></thead>
          <tbody>
            ${(users.results || []).map((user) => `
              <tr>
                <td>${escapeHtml(user.email)}</td>
                <td colspan="6">
                  <form class="row-form" method="post" action="/admin/users/update">
                    <input type="hidden" name="id" value="${user.id}">
                    <select name="role">
                      <option value="user"${user.role === "user" ? " selected" : ""}>User</option>
                      <option value="admin"${user.role === "admin" ? " selected" : ""}>Admin label</option>
                    </select>
                    <select name="status">
                      <option value="active"${user.status === "active" ? " selected" : ""}>Active</option>
                      <option value="disabled"${user.status === "disabled" ? " selected" : ""}>Disabled</option>
                    </select>
                    <input name="quota_daily" type="number" min="0" value="${Number(user.quota_daily) || 0}">
                    <input name="quota_minute" type="number" min="0" value="${Number(user.quota_minute) || 0}">
                    <span>${Number(user.token_count) || 0}</span>
                    <button type="submit">Save</button>
                  </form>
                </td>
              </tr>
            `).join("") || `<tr><td colspan="7">No users yet.</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>Tokens</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>User</th><th>Name</th><th>Prefix</th><th>Status</th><th>Expires</th><th>Last used</th><th></th></tr></thead>
          <tbody>
            ${(tokens.results || []).map((token) => `
              <tr>
                <td>${escapeHtml(token.email)}</td>
                <td>${escapeHtml(token.name || "")}</td>
                <td><code>${escapeHtml(token.token_prefix || "")}</code></td>
                <td>${escapeHtml(token.status)}</td>
                <td>${escapeHtml(token.expires_at || "Never")}</td>
                <td>${escapeHtml(token.last_used_at || "Never")}</td>
                <td>
                  ${token.status === "active" && Number(token.can_copy) ? `
                    <form method="post" action="/admin/tokens/copy">
                      <input type="hidden" name="id" value="${token.id}">
                      <button class="secondary" type="submit">Copy</button>
                    </form>
                  ` : ""}
                  ${token.status === "active" ? `
                    <form method="post" action="/admin/tokens/revoke">
                      <input type="hidden" name="id" value="${token.id}">
                      <button class="secondary" type="submit">Revoke</button>
                    </form>
                  ` : ""}
                </td>
              </tr>
            `).join("") || `<tr><td colspan="7">No tokens yet.</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>Recent usage</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Time</th><th>User</th><th>Scope</th><th>Mode</th><th>Chars</th><th>Status</th><th>Error</th></tr></thead>
          <tbody>
            ${(usage.results || []).map((event) => `
              <tr>
                <td>${escapeHtml(event.created_at)}</td>
                <td>${escapeHtml(event.email || "")}</td>
                <td>${escapeHtml(event.scope)}</td>
                <td>${escapeHtml(event.mode)}</td>
                <td>${Number(event.input_length) || 0}</td>
                <td>${event.success ? "OK" : "Failed"}</td>
                <td>${escapeHtml(event.error || "")}</td>
              </tr>
            `).join("") || `<tr><td colspan="7">No usage yet.</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
  `;

  return adminShell("Admin dashboard", body, session.admin_email);
}

function renderLoginPage(env, error = "") {
  const setupWarning = !env.ADMIN_EMAIL || !env.ADMIN_PASSWORD_HASH || !env.SESSION_SECRET
    ? "Admin login needs ADMIN_EMAIL, ADMIN_PASSWORD_HASH, and SESSION_SECRET secrets."
    : "";

  return adminShell("Admin login", `
    ${error ? `<div class="alert error">${escapeHtml(error)}</div>` : ""}
    ${setupWarning ? `<div class="alert error">${escapeHtml(setupWarning)}</div>` : ""}
    <section class="login-card">
      <form method="post" action="/admin/login">
        <label>Email <input name="email" type="email" autocomplete="username" required></label>
        <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
        <button type="submit">Log in</button>
      </form>
    </section>
  `);
}

function adminShell(title, body, adminEmail = "") {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)} - Grammar Assistant</title>
    <style>
      :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #16213d; background: #f6f8fb; }
      * { box-sizing: border-box; }
      body { margin: 0; }
      main { max-width: 1180px; margin: 0 auto; padding: 28px 18px 48px; }
      header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 22px; }
      h1 { margin: 0; font-size: 24px; line-height: 1.2; }
      h2 { margin: 0 0 12px; font-size: 16px; }
      p { color: #5d6b82; }
      section, article { margin: 0 0 18px; padding: 16px; border: 1px solid rgba(22,33,61,.11); border-radius: 8px; background: #fff; box-shadow: 0 8px 28px rgba(22,33,61,.06); }
      .grid { display: grid; gap: 18px; }
      .two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      .quick-card { display: grid; grid-template-columns: minmax(220px, .85fr) 2fr; gap: 18px; align-items: end; border-color: rgba(23,107,93,.2); }
      .quick-card h2 { margin-bottom: 6px; font-size: 22px; }
      .quick-card p { margin: 0; }
      .eyebrow { margin: 0 0 4px; color: #176b5d; font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: .02em; }
      .quick-form { display: grid; grid-template-columns: 1.35fr .7fr .7fr .9fr auto; gap: 10px; align-items: end; }
      .quick-form label { margin-bottom: 0; }
      .admin-details { margin: 0 0 18px; }
      .admin-details summary { margin-bottom: 12px; cursor: pointer; color: #334155; font-weight: 800; }
      .admin-details .grid { margin: 0; }
      .admin-details article { margin: 0; box-shadow: none; }
      label { display: grid; gap: 6px; margin-bottom: 10px; font-size: 12px; font-weight: 700; color: #334155; }
      input, select { width: 100%; min-height: 38px; border: 1px solid rgba(22,33,61,.16); border-radius: 7px; padding: 0 10px; color: #16213d; background: #fff; font: inherit; }
      button { min-height: 36px; border: 1px solid #176b5d; border-radius: 7px; padding: 0 12px; color: #fff; background: #176b5d; cursor: pointer; font-weight: 750; }
      button.secondary { border-color: rgba(22,33,61,.16); color: #16213d; background: #fff; }
      .alert { margin: 0 0 16px; padding: 11px 12px; border: 1px solid rgba(23,107,93,.22); border-radius: 8px; color: #064e3b; background: #ecfdf5; font-weight: 700; }
      .alert.error { border-color: rgba(220,38,38,.22); color: #991b1b; background: #fef2f2; }
      .help-box { border-color: rgba(217,119,6,.18); background: #fffbeb; }
      .help-box p { margin: 0; color: #78350f; }
      .ai-settings-card { display: grid; gap: 12px; background: #fff; }
      .ai-settings-card h2 { margin-bottom: 6px; }
      .ai-settings-card p { margin: 0; color: #5d6b82; }
      .ai-settings-form { display: grid; grid-template-columns: .85fr 1.35fr 1fr 1.35fr auto; gap: 10px; align-items: end; }
      .ai-settings-form label { margin-bottom: 0; }
      .settings-note { font-size: 12px; font-weight: 700; }
      .settings-note strong { color: #16213d; }
      .settings-note .status-connected { color: #047857; }
      .settings-note .status-failed { color: #b91c1c; }
      .settings-note .status-not_checked { color: #92400e; }
      .save-status { min-height: 18px; font-size: 12px; font-weight: 800; }
      .save-status.success { color: #047857; }
      .save-status.error { color: #b91c1c; }
      .save-status.pending { color: #92400e; }
      button:disabled { cursor: wait; opacity: .72; }
      .secret-box code { display: block; padding: 12px; border-radius: 7px; color: #111827; background: #f8fafc; overflow: auto; user-select: all; }
      .copy-row { display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: stretch; }
      .copy-row button { min-width: 110px; }
      .metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
      .metrics span { display: grid; gap: 3px; padding: 10px; border-radius: 7px; background: #f8fafc; color: #64748b; font-size: 12px; }
      .metrics strong { color: #16213d; font-size: 14px; }
      .table-wrap { overflow: auto; }
      table { width: 100%; border-collapse: collapse; min-width: 780px; }
      th, td { padding: 9px 8px; border-bottom: 1px solid rgba(22,33,61,.09); text-align: left; vertical-align: middle; font-size: 12px; }
      th { color: #475569; font-weight: 800; background: #f8fafc; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
      .row-form { display: grid; grid-template-columns: 110px 110px 90px 90px 54px 72px; gap: 8px; align-items: center; }
      .row-form input, .row-form select { min-height: 32px; }
      .login-card { max-width: 420px; }
      .top-actions { display: flex; align-items: center; gap: 10px; }
      .admin-email { color: #64748b; font-size: 13px; font-weight: 700; }
      td form + form { margin-top: 6px; }
      @media (max-width: 1100px) { .ai-settings-form { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
      @media (max-width: 960px) { .quick-card, .quick-form { grid-template-columns: 1fr; } }
      @media (max-width: 820px) { .two, .metrics, .copy-row { grid-template-columns: 1fr; } header { align-items: flex-start; flex-direction: column; } }
      @media (max-width: 640px) { .ai-settings-form { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>${escapeHtml(title)}</h1>
        ${adminEmail ? `
          <div class="top-actions">
            <span class="admin-email">${escapeHtml(adminEmail)}</span>
            <form method="post" action="/admin/logout"><button class="secondary" type="submit">Log out</button></form>
          </div>
        ` : ""}
      </header>
      ${body}
    </main>
    <script>
      document.querySelectorAll("[data-copy-token]").forEach((button) => {
        button.addEventListener("click", async () => {
          const token = document.querySelector("#tokenValue")?.textContent?.trim() || "";
          if (!token) return;
          try {
            await navigator.clipboard.writeText(token);
            button.textContent = "Copied";
            setTimeout(() => { button.textContent = "Copy token"; }, 1600);
          } catch {
            button.textContent = "Select token";
          }
        });
      });

      const providerSelect = document.querySelector("[data-ai-provider]");
      const apiUrlInput = document.querySelector("[data-ai-api-url]");
      const modelInput = document.querySelector("[data-ai-model]");
      const aiSettingsForm = document.querySelector("[data-ai-settings-form]");
      const aiApiKeyInput = document.querySelector("[data-ai-api-key]");
      const aiSubmit = document.querySelector("[data-ai-submit]");
      const aiSaveStatus = document.querySelector("[data-ai-save-status]");
      const aiSource = document.querySelector("[data-ai-source]");
      const aiKeyStatus = document.querySelector("[data-ai-key-status]");
      const aiConnectionStatus = document.querySelector("[data-ai-connection-status]");
      const aiReadyStatus = document.querySelector("[data-ai-ready-status]");
      const aiCheckedAt = document.querySelector("[data-ai-checked-at]");
      const healthProvider = document.querySelector("[data-health-provider]");
      const healthKey = document.querySelector("[data-health-key]");
      const healthConnection = document.querySelector("[data-health-connection]");

      function setAiSaveStatus(message, type = "") {
        if (!aiSaveStatus) return;
        aiSaveStatus.textContent = message;
        aiSaveStatus.className = ["save-status", type].filter(Boolean).join(" ");
      }

      providerSelect?.addEventListener("change", () => {
        const option = providerSelect.selectedOptions?.[0];
        if (!option) return;
        if (apiUrlInput) apiUrlInput.value = option.dataset.defaultUrl || "";
        if (modelInput) modelInput.value = option.dataset.defaultModel || "";
        setAiSaveStatus("");
      });

      aiSettingsForm?.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!aiSubmit) return;
        if (!aiApiKeyInput?.value.trim()) {
          setAiSaveStatus("API key is required.", "error");
          aiApiKeyInput?.focus();
          return;
        }

        const originalText = aiSubmit.textContent;
        aiSubmit.disabled = true;
        aiSubmit.textContent = "Testing...";
        setAiSaveStatus("Saving and testing provider...", "pending");

        try {
          const response = await fetch(aiSettingsForm.action, {
            method: "POST",
            body: new FormData(aiSettingsForm),
            headers: {
              Accept: "application/json",
              "X-Requested-With": "fetch"
            }
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || !data.ok) {
            throw new Error(data.error || "Could not save AI settings.");
          }

          if (apiUrlInput) apiUrlInput.value = data.apiUrl || "";
          if (modelInput) modelInput.value = data.model || "";
          if (aiApiKeyInput) {
            aiApiKeyInput.value = data.apiKey || aiApiKeyInput.value;
          }
          if (aiSource) aiSource.textContent = data.source || "";
          if (aiKeyStatus) aiKeyStatus.textContent = data.hasApiKey ? "saved" : "required";
          if (aiConnectionStatus) {
            aiConnectionStatus.textContent = connectionLabel(data.connectionStatus);
            aiConnectionStatus.className = "status-" + (data.connectionStatus || "not_checked");
          }
          if (aiReadyStatus) aiReadyStatus.textContent = data.readyStatus || "not ready";
          if (aiCheckedAt) aiCheckedAt.textContent = data.connectionCheckedAt ? "· Checked: " + data.connectionCheckedAt : "";
          if (healthProvider) healthProvider.textContent = data.provider || "";
          if (healthKey) healthKey.textContent = data.hasApiKey ? "configured" : "demo fallback";
          if (healthConnection) healthConnection.textContent = connectionLabel(data.connectionStatus);

          setAiSaveStatus(data.connectionMessage || data.notice || "Saved.", data.connectionStatus === "failed" ? "error" : "success");
        } catch (error) {
          setAiSaveStatus(error?.message || "Could not save AI settings.", "error");
        } finally {
          aiSubmit.disabled = false;
          aiSubmit.textContent = originalText;
        }
      });

      function connectionLabel(status) {
        if (status === "connected") return "connected";
        if (status === "failed") return "failed";
        return "not checked";
      }
    </script>
  </body>
</html>`;
}

async function getQaChecks(url, env) {
  if (!env.DB) {
    return json({ error: "D1 database is not bound" }, 500);
  }

  const requestedLimit = Number(url.searchParams.get("limit") || 25);
  const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 25, 1), 100);
  const result = await env.DB.prepare(
    `SELECT id,
            created_at,
            mode,
            language,
            page_url,
            input_length,
            corrected_length,
            suggestion_count,
            success,
            error,
            input_preview,
            corrected_preview
       FROM grammar_checks
      ORDER BY id DESC
      LIMIT ?`
  )
    .bind(limit)
    .all();

  return json({
    checks: result.results || [],
    limit
  });
}

async function recordGrammarCheck(env, event) {
  if (!env.DB) {
    return;
  }

  try {
    const storePreviews = String(env.STORE_QA_PREVIEWS || "").toLowerCase() === "true";
    await env.DB.prepare(
      `INSERT INTO grammar_checks (
          mode,
          language,
          page_url,
          input_length,
          corrected_length,
          suggestion_count,
          success,
          error,
          input_preview,
          corrected_preview
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        event.mode,
        event.language,
        event.pageUrl || "",
        event.inputText?.length || 0,
        event.correctedText?.length || 0,
        event.suggestionCount || 0,
        event.success ? 1 : 0,
        event.error || "",
        storePreviews ? preview(event.inputText || "") : "",
        storePreviews ? preview(event.correctedText || "") : ""
      )
      .run();

    await pruneOldGrammarChecks(env);
  } catch (error) {
    console.warn("Failed to record grammar check", error);
  }
}

async function pruneOldGrammarChecks(env) {
  const retentionDays = Number(env.QA_RETENTION_DAYS || 30);
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    return;
  }

  await env.DB.prepare("DELETE FROM grammar_checks WHERE created_at < datetime('now', ?)")
    .bind(`-${Math.floor(retentionDays)} days`)
    .run();
}

async function getStoredAiSettings(env) {
  if (!env.DB) {
    return null;
  }

  await ensureAuthSchema(env);
  const row = await env.DB.prepare(
    `SELECT provider,
            api_url,
            model,
            api_key_ciphertext,
            connection_status,
            connection_checked_at,
            connection_message
       FROM ai_settings
      WHERE id = 1
      LIMIT 1`
  )
    .first();

  if (!row) {
    return null;
  }

  let apiKey = "";
  if (row.api_key_ciphertext) {
    try {
      apiKey = await decryptSecret(row.api_key_ciphertext, env);
    } catch {
      throw new Error("Saved AI API key could not be decrypted. Save it again from the admin dashboard.");
    }
  }

  return {
    provider: normalizeAiProvider(row.provider),
    apiUrl: safeString(row.api_url, ""),
    model: safeString(row.model, ""),
    apiKey,
    connectionStatus: normalizeConnectionStatus(row.connection_status),
    connectionCheckedAt: safeString(row.connection_checked_at, ""),
    connectionMessage: safeString(row.connection_message, "")
  };
}

async function getAiSettingsForDashboard(env) {
  const stored = await getStoredAiSettings(env);
  const provider = stored?.provider || getAiProvider(env);
  const hasAdminKey = Boolean(stored?.apiKey);
  const hasEnvKey = Boolean(env.AI_API_KEY);

  return {
    provider,
    apiUrl: normalizeApiUrlForProvider(provider, stored?.apiUrl || env.AI_API_URL || ""),
    model: normalizeModelForProvider(provider, stored?.model || env.AI_MODEL || ""),
    apiKey: stored?.apiKey || "",
    hasApiKey: hasAdminKey,
    hasRuntimeKey: hasAdminKey || hasEnvKey,
    connectionStatus: stored?.connectionStatus || "not_checked",
    connectionLabel: getConnectionLabel(stored?.connectionStatus || "not_checked"),
    connectionCheckedAt: stored?.connectionCheckedAt || "",
    connectionMessage: stored?.connectionMessage || "",
    readyStatus: getReadyStatus({
      hasApiKey: hasAdminKey,
      connectionStatus: stored?.connectionStatus || "not_checked"
    }),
    source: stored
      ? hasAdminKey
        ? "saved"
        : hasEnvKey
          ? "missing in admin"
          : "missing"
      : hasEnvKey
        ? "missing in admin"
        : "missing"
  };
}

async function saveAiConnectionStatus(env, connection) {
  if (!env.DB) {
    return;
  }

  await env.DB.prepare(
    `UPDATE ai_settings
        SET connection_status = ?,
            connection_checked_at = datetime('now'),
            connection_message = ?,
            updated_at = datetime('now')
      WHERE id = 1`
  )
    .bind(connection.ok ? "connected" : "failed", connection.message)
    .run();
}

async function testAiConnection(aiConfig) {
  try {
    let workingApiUrl = "";
    if (aiConfig.provider === "gemini") {
      await testGeminiConnection(aiConfig);
    } else {
      workingApiUrl = await testOpenAiCompatibleConnection(aiConfig);
    }

    return {
      ok: true,
      message: `${providerLabel(aiConfig.provider)} connected successfully.`,
      workingApiUrl
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Connection test failed.";
    return { ok: false, message: detail };
  }
}

async function testOpenAiCompatibleConnection(aiConfig) {
  const errors = [];
  const urls = getOpenAiCompatibleUrlCandidates(aiConfig);

  for (const url of urls) {
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${aiConfig.apiKey}`
      },
      body: JSON.stringify({
        model: aiConfig.model || getDefaultModel(aiConfig.provider),
        temperature: 0,
        max_tokens: 4,
        messages: [
          {
            role: "user",
            content: "Reply with OK."
          }
        ]
      })
    }, 12000);

    const data = await response.json().catch(() => null);
    if (response.ok) {
      return url;
    }

    const detail = data?.error?.message || data?.message || response.statusText;
    errors.push({ url, status: response.status, detail });
  }

  if (aiConfig.provider === "qwen") {
    const detail = summarizeProviderErrors(errors);
    throw new Error(`Qwen API test failed on all DashScope endpoints. ${detail} Check that the key is a Model Studio DashScope API key for Qwen, copied fully, active, and from the same Alibaba account/region.`);
  }

  const first = errors[0];
  throw new Error(`${providerLabel(aiConfig.provider)} API test failed: ${first?.detail || "Connection failed."}`);
}

async function testGeminiConnection(aiConfig) {
  const model = aiConfig.model || getDefaultModel("gemini");
  const url = aiConfig.apiUrl ||
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const endpoint = new URL(url);
  if (!endpoint.searchParams.has("key")) {
    endpoint.searchParams.set("key", aiConfig.apiKey);
  }

  const response = await fetchWithTimeout(endpoint.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: "Reply with OK." }]
        }
      ],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 4
      }
    })
  }, 12000);

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = data?.error?.message || data?.message || response.statusText;
    throw new Error(`Gemini API test failed: ${detail}`);
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("AI provider test timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function checkText({ text, mode, language, pageUrl, scope, env }) {
  const aiConfig = await getAiConfig(env);
  if (!aiConfig.apiKey) {
    return demoCheck(text, mode);
  }

  const prompt = buildPrompt({ text, mode, language, pageUrl, scope });

  if (aiConfig.provider === "gemini") {
    return callGemini({ prompt, text, aiConfig });
  }

  return callOpenAiCompatible({ prompt, text, aiConfig });
}

async function callOpenAiCompatible({ prompt, text, aiConfig }) {
  const response = await fetch(getOpenAiCompatibleUrl(aiConfig), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${aiConfig.apiKey}`
    },
    body: JSON.stringify({
      model: aiConfig.model || getDefaultModel(aiConfig.provider),
      temperature: 0,
      max_tokens: 700,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Return compact valid JSON only. Find actual grammar, spelling, clarity, or style errors in the input. Use exact zero-based offsets. Include at most 8 issues. Do not include correct words, no-op replacements, or general notes."
        },
        {
          role: "user",
          content: prompt
        }
      ]
    })
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = data?.error?.message || data?.message || response.statusText;
    throw new Error(`${providerLabel(aiConfig.provider)} API error: ${detail}`);
  }

  const content = data?.choices?.[0]?.message?.content || "";
  return normalizeModelResponse(content, text);
}

async function callGemini({ prompt, text, aiConfig }) {
  const model = aiConfig.model || getDefaultModel("gemini");
  const url = aiConfig.apiUrl ||
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const endpoint = new URL(url);
  if (!endpoint.searchParams.has("key")) {
    endpoint.searchParams.set("key", aiConfig.apiKey);
  }

  const response = await fetch(endpoint.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json"
      }
    })
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = data?.error?.message || data?.message || response.statusText;
    throw new Error(`Gemini API error: ${detail}`);
  }

  const content = data?.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("")
    .trim() || "";
  return normalizeModelResponse(content, text);
}

async function getAiConfig(env) {
  const stored = await getStoredAiSettings(env);
  const provider = stored?.provider || getAiProvider(env);
  const apiKey = stored?.apiKey || env.AI_API_KEY || "";
  const apiUrl = normalizeApiUrlForProvider(provider, stored?.apiUrl || env.AI_API_URL || "");
  const model = normalizeModelForProvider(provider, stored?.model || env.AI_MODEL || "");

  return {
    provider,
    apiKey,
    apiUrl,
    model,
    source: stored?.apiKey ? "admin settings" : "Cloudflare secrets"
  };
}

function getAiProvider(env) {
  const provider = String(env.AI_PROVIDER || "").trim().toLowerCase();
  if (["openai", "qwen", "gemini", "custom"].includes(provider)) {
    return provider;
  }

  const url = String(env.AI_API_URL || "").toLowerCase();
  if (url.includes("dashscope")) {
    return "qwen";
  }
  if (url.includes("generativelanguage.googleapis.com")) {
    return "gemini";
  }
  return "openai";
}

function getOpenAiCompatibleUrl(aiConfig) {
  if (aiConfig.apiUrl) {
    return aiConfig.apiUrl;
  }

  if (aiConfig.provider === "qwen") {
    return "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions";
  }

  return "https://api.openai.com/v1/chat/completions";
}

function getOpenAiCompatibleUrlCandidates(aiConfig) {
  const urls = [];
  const addUrl = (url) => {
    const value = safeString(url, "");
    if (value && !urls.includes(value)) {
      urls.push(value);
    }
  };

  addUrl(aiConfig.apiUrl);

  if (aiConfig.provider === "qwen") {
    addUrl("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions");
    addUrl("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
  } else {
    addUrl(getOpenAiCompatibleUrl(aiConfig));
  }

  return urls;
}

function summarizeProviderErrors(errors) {
  if (!errors.length) {
    return "";
  }

  const uniqueDetails = [...new Set(errors.map((error) => `${error.status}: ${error.detail}`))];
  return `Last errors: ${uniqueDetails.slice(0, 2).join(" | ")}.`;
}

function getDefaultApiUrl(provider) {
  return {
    openai: "https://api.openai.com/v1/chat/completions",
    qwen: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
    gemini: "",
    custom: ""
  }[normalizeAiProvider(provider)] || "";
}

function normalizeApiUrlForProvider(provider, apiUrl) {
  const normalizedProvider = normalizeAiProvider(provider);
  const value = safeString(apiUrl, "").trim();

  if (normalizedProvider === "custom") {
    return value;
  }

  if (!value || isKnownDefaultApiUrl(value)) {
    return getDefaultApiUrl(normalizedProvider);
  }

  return value;
}

function isKnownDefaultApiUrl(apiUrl) {
  const value = safeString(apiUrl, "")
    .trim()
    .replace(/\/+$/, "")
    .toLowerCase();
  return [
    "https://api.openai.com/v1/chat/completions",
    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
  ].includes(value);
}

function normalizeModelForProvider(provider, model) {
  const value = safeString(model, "").trim();
  if (!value || isKnownDefaultModel(value)) {
    return getDefaultModel(provider);
  }

  return value;
}

function isKnownDefaultModel(model) {
  return [
    "gpt-4.1-mini",
    "qwen-plus",
    "gemini-1.5-flash",
    "gemini-1.5-flash-latest",
    "gemini-2.5-flash"
  ].includes(safeString(model, "").trim().toLowerCase());
}

function normalizeAiProvider(value) {
  return ["openai", "qwen", "gemini", "custom"].includes(value) ? value : "openai";
}

function getDefaultModel(provider) {
  return {
    openai: "gpt-4.1-mini",
    qwen: "qwen-plus",
    gemini: "gemini-2.5-flash",
    custom: "gpt-4.1-mini"
  }[normalizeAiProvider(provider)];
}

function providerLabel(provider) {
  return {
    openai: "AI",
    qwen: "Qwen",
    gemini: "Gemini",
    custom: "Custom AI"
  }[provider] || "AI";
}

function normalizeConnectionStatus(status) {
  return ["connected", "failed", "not_checked"].includes(status) ? status : "not_checked";
}

function getConnectionLabel(status) {
  return {
    connected: "connected",
    failed: "failed",
    not_checked: "not checked"
  }[normalizeConnectionStatus(status)];
}

function getReadyStatus({ hasApiKey, connectionStatus }) {
  if (!hasApiKey) {
    return "not ready";
  }
  if (connectionStatus === "connected") {
    return "ready";
  }
  if (connectionStatus === "failed") {
    return "needs fix";
  }
  return "test needed";
}

function buildPrompt({ text, mode, language, pageUrl, scope }) {
  return JSON.stringify({
    task: mode,
    language,
    pageUrl,
    scope,
    requiredResponseShape: {
      correctedText: "string",
      issues: [
        {
          start: "number, zero-based inclusive offset in original text",
          end: "number, zero-based exclusive offset in original text",
          original: "string from original text",
          replacement: "string",
          title: "string",
          explanation: "string",
          severity: "grammar|spelling|style|clarity"
        }
      ],
      suggestions: [
        {
          title: "string",
          replacement: "string",
          explanation: "string",
          severity: "grammar|spelling|style|clarity"
        }
      ]
    },
    text
  });
}

function normalizeModelResponse(content, fallbackText) {
  const parsed = parseJsonFromText(content);
  if (!parsed) {
    return {
      correctedText: String(content || fallbackText),
      suggestions: [],
      issues: []
    };
  }

  const issues = normalizeIssues(parsed.issues, fallbackText);
  const suggestions = Array.isArray(parsed.suggestions)
    ? parsed.suggestions.map((item, index) => ({
        title: safeString(item.title || item.label || item.issue, `Suggestion ${index + 1}`),
        replacement: safeString(
          item.replacement || item.correctedText || item.corrected_text || item.text,
          ""
        ),
        explanation: safeString(item.explanation || item.reason || item.message, ""),
        severity: safeString(item.severity || item.type, "suggestion")
      }))
    : issues.map((item) => ({
        title: item.title,
        replacement: item.replacement,
        explanation: item.explanation,
        severity: item.severity
      }));

  return {
    correctedText: safeString(
      parsed.correctedText || parsed.corrected_text || parsed.replacement || parsed.text,
      fallbackText
    ),
    suggestions,
    issues
  };
}

function normalizeIssues(rawIssues, originalText) {
  if (!Array.isArray(rawIssues)) {
    return [];
  }

  return rawIssues
    .map((item, index) => normalizeIssue(item, index, originalText))
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);
}

function normalizeIssue(item, index, originalText) {
  const original = safeString(item.original || item.text || item.issueText, "");
  const replacement = safeString(
    item.replacement || item.correctedText || item.corrected_text || item.suggestion,
    ""
  );
  let start = Number(item.start);
  let end = Number(item.end);

  if ((!Number.isInteger(start) || !Number.isInteger(end)) && original) {
    const found = originalText.indexOf(original);
    if (found >= 0) {
      start = found;
      end = found + original.length;
    }
  }

  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return null;
  }

  if (original && originalText.slice(start, end) !== original) {
    const found = findIssueOffset(originalText, original, start);
    if (found >= 0) {
      start = found;
      end = found + original.length;
    }
  }

  if (start < 0 || end <= start || end > originalText.length) {
    return null;
  }

  const sourceText = original || originalText.slice(start, end);
  if (sourceText && !hasBoundary(originalText, start, end, sourceText)) {
    const found = findIssueOffset(originalText, sourceText, start, { requireBoundary: true });
    if (found >= 0) {
      start = found;
      end = found + sourceText.length;
    }
  }

  if (!replacement || replacement === sourceText) {
    return null;
  }

  return {
    start,
    end,
    original: sourceText,
    replacement,
    title: safeString(item.title || item.label || item.issue, `Suggestion ${index + 1}`),
    explanation: safeString(item.explanation || item.reason || item.message, ""),
    severity: safeString(item.severity || item.type, "grammar")
  };
}

function findIssueOffset(text, original, preferredStart, options = {}) {
  const direct = text.indexOf(original);
  if (direct < 0) {
    return -1;
  }

  const matches = [];
  let start = direct;
  while (start >= 0) {
    const end = start + original.length;
    if (!options.requireBoundary || hasBoundary(text, start, end, original)) {
      matches.push(start);
    }
    start = text.indexOf(original, start + original.length);
  }

  if (!matches.length) {
    return -1;
  }

  return matches.reduce((best, current) => {
    return Math.abs(current - preferredStart) < Math.abs(best - preferredStart) ? current : best;
  }, matches[0]);
}

function hasBoundary(text, start, end, sourceText) {
  if (!/^[A-Za-z0-9']+$/.test(sourceText)) {
    return true;
  }

  const before = start > 0 ? text[start - 1] : "";
  const after = end < text.length ? text[end] : "";
  return !/[A-Za-z0-9']/.test(before) && !/[A-Za-z0-9']/.test(after);
}

function parseJsonFromText(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }

    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function demoCheck(text, mode) {
  let correctedText = text
    .replace(/\bThis are\b/g, "This is")
    .replace(/\bthis are\b/g, "this is")
    .replace(/\bI has\b/g, "I have")
    .replace(/\bi has\b/g, "i have");

  if (mode === "shorten") {
    correctedText = correctedText
      .replace(/\bin order to\b/gi, "to")
      .replace(/\bat this point in time\b/gi, "now");
  }

  const issues = buildDemoIssues(text, correctedText);

  return {
    correctedText,
    suggestions:
      correctedText === text
        ? []
        : [
            {
              title: "Demo correction",
              replacement: correctedText,
              explanation: "Set AI_API_KEY in Cloudflare Worker secrets for full AI checking.",
              severity: "grammar"
            }
          ],
    issues
  };
}

function buildDemoIssues(originalText, correctedText) {
  if (originalText === correctedText) {
    return [];
  }

  const rules = [
    { original: "This are", replacement: "This is", title: "Subject-verb agreement" },
    { original: "this are", replacement: "this is", title: "Subject-verb agreement" },
    { original: "I has", replacement: "I have", title: "Verb agreement" },
    { original: "i has", replacement: "i have", title: "Verb agreement" },
    { original: "in order to", replacement: "to", title: "Concise wording" },
    { original: "at this point in time", replacement: "now", title: "Concise wording" }
  ];

  const issues = [];
  for (const rule of rules) {
    let start = originalText.indexOf(rule.original);
    while (start >= 0) {
      issues.push({
        start,
        end: start + rule.original.length,
        original: rule.original,
        replacement: rule.replacement,
        title: rule.title,
        explanation: `Replace "${rule.original}" with "${rule.replacement}".`,
        severity: "grammar"
      });
      start = originalText.indexOf(rule.original, start + rule.original.length);
    }
  }

  return issues.sort((a, b) => a.start - b.start);
}

async function ensureAuthSchema(env) {
  if (!env.DB) {
    return;
  }

  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      const statements = [
        `CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          email TEXT NOT NULL UNIQUE,
          role TEXT NOT NULL DEFAULT 'user',
          status TEXT NOT NULL DEFAULT 'active',
          quota_daily INTEGER NOT NULL DEFAULT ${DEFAULT_DAILY_QUOTA},
          quota_minute INTEGER NOT NULL DEFAULT ${DEFAULT_MINUTE_QUOTA}
        )`,
        `CREATE TABLE IF NOT EXISTS api_tokens (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          user_id INTEGER NOT NULL,
          name TEXT NOT NULL DEFAULT 'Chrome extension',
          token_prefix TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          token_ciphertext TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          expires_at TEXT,
          last_used_at TEXT,
          FOREIGN KEY (user_id) REFERENCES users(id)
        )`,
        `CREATE TABLE IF NOT EXISTS usage_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          user_id INTEGER,
          token_id INTEGER,
          scope TEXT NOT NULL DEFAULT 'panel',
          mode TEXT NOT NULL DEFAULT 'grammar',
          input_length INTEGER NOT NULL DEFAULT 0,
          success INTEGER NOT NULL DEFAULT 1,
          error TEXT,
          FOREIGN KEY (user_id) REFERENCES users(id),
          FOREIGN KEY (token_id) REFERENCES api_tokens(id)
        )`,
        `CREATE TABLE IF NOT EXISTS admin_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          admin_email TEXT NOT NULL,
          session_hash TEXT NOT NULL UNIQUE,
          expires_at TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS ai_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          provider TEXT NOT NULL DEFAULT 'openai',
          api_url TEXT,
          model TEXT,
          api_key_ciphertext TEXT,
          connection_status TEXT NOT NULL DEFAULT 'not_checked',
          connection_checked_at TEXT,
          connection_message TEXT
        )`,
        "CREATE INDEX IF NOT EXISTS idx_api_tokens_token_hash ON api_tokens(token_hash)",
        "CREATE INDEX IF NOT EXISTS idx_api_tokens_user_status ON api_tokens(user_id, status)",
        "CREATE INDEX IF NOT EXISTS idx_usage_events_user_created ON usage_events(user_id, created_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_usage_events_token_created ON usage_events(token_id, created_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_admin_sessions_hash ON admin_sessions(session_hash)",
        "CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expires_at)"
      ];

      for (const statement of statements) {
        await env.DB.prepare(statement).run();
      }

      const tokenColumns = await env.DB.prepare("PRAGMA table_info(api_tokens)").all();
      const hasTokenCiphertext = (tokenColumns.results || []).some((column) => column.name === "token_ciphertext");
      if (!hasTokenCiphertext) {
        await env.DB.prepare("ALTER TABLE api_tokens ADD COLUMN token_ciphertext TEXT").run();
      }

      const aiColumns = await env.DB.prepare("PRAGMA table_info(ai_settings)").all();
      const aiColumnNames = new Set((aiColumns.results || []).map((column) => column.name));
      if (!aiColumnNames.has("connection_status")) {
        await env.DB.prepare("ALTER TABLE ai_settings ADD COLUMN connection_status TEXT NOT NULL DEFAULT 'not_checked'").run();
      }
      if (!aiColumnNames.has("connection_checked_at")) {
        await env.DB.prepare("ALTER TABLE ai_settings ADD COLUMN connection_checked_at TEXT").run();
      }
      if (!aiColumnNames.has("connection_message")) {
        await env.DB.prepare("ALTER TABLE ai_settings ADD COLUMN connection_message TEXT").run();
      }

      await env.DB.prepare(
        `INSERT OR IGNORE INTO ai_settings (id, provider, api_url, model)
         VALUES (1, ?, ?, ?)`
      )
        .bind(getAiProvider(env), env.AI_API_URL || "", env.AI_MODEL || getDefaultModel(getAiProvider(env)))
        .run();
    })();
  }

  return schemaReadyPromise;
}

async function verifyPassword(password, storedHash) {
  const value = String(storedHash || "").trim();
  if (!value || !password) {
    return false;
  }

  if (value.startsWith("pbkdf2:")) {
    const [, iterationsRaw, saltRaw, expectedRaw] = value.split(":");
    const iterations = Number(iterationsRaw);
    if (!Number.isInteger(iterations) || iterations < 10000 || iterations > 100000 || !saltRaw || !expectedRaw) {
      return false;
    }

    const derived = await pbkdf2(password, base64UrlToBytes(saltRaw), iterations, 32);
    return timingSafeEqual(base64UrlEncode(derived), expectedRaw);
  }

  if (value.startsWith("sha256:")) {
    return timingSafeEqual(await sha256Hex(password), value.slice("sha256:".length));
  }

  return false;
}

async function pbkdf2(password, salt, iterations, length) {
  const key = await crypto.subtle.importKey(
    "raw",
    textBytes(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations
    },
    key,
    length * 8
  );
  return new Uint8Array(bits);
}

async function hashToken(token, env) {
  return sha256Hex(`${getTokenSecret(env)}:${token}`);
}

async function encryptToken(token, env) {
  return encryptSecret(token, env);
}

async function decryptToken(value, env) {
  return decryptSecret(value, env);
}

async function encryptSecret(value, env) {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const key = await getTokenEncryptionKey(env);
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv
    },
    key,
    textBytes(value)
  );

  return `v1:${base64UrlEncode(iv)}:${base64UrlEncode(new Uint8Array(encrypted))}`;
}

async function decryptSecret(value, env) {
  const [version, ivRaw, encryptedRaw] = String(value || "").split(":");
  if (version !== "v1" || !ivRaw || !encryptedRaw) {
    throw new Error("Unsupported encrypted secret format");
  }

  const key = await getTokenEncryptionKey(env);
  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64UrlToBytes(ivRaw)
    },
    key,
    base64UrlToBytes(encryptedRaw)
  );

  return new TextDecoder().decode(decrypted);
}

async function getTokenEncryptionKey(env) {
  const secretHash = await crypto.subtle.digest("SHA-256", textBytes(getTokenSecret(env)));
  return crypto.subtle.importKey(
    "raw",
    secretHash,
    "AES-GCM",
    false,
    ["encrypt", "decrypt"]
  );
}

async function hashSession(token, env) {
  return sha256Hex(`${env.SESSION_SECRET || ""}:session:${token}`);
}

function getTokenSecret(env) {
  return env.TOKEN_SECRET || env.SESSION_SECRET || env.GRAMMAR_API_KEY || "development-token-secret";
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", textBytes(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function secretsEqual(left, right) {
  return timingSafeEqual(await sha256Hex(left), await sha256Hex(right));
}

function timingSafeEqual(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let index = 0; index < a.length; index += 1) {
    result |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return result === 0;
}

function createSecretToken(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function base64UrlEncode(bytes) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const padded = String(value || "").replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function textBytes(value) {
  return new TextEncoder().encode(String(value || ""));
}

function getBearerToken(request) {
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function getCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  return cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1) || "";
}

function buildSessionCookie(value, request, maxAge) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${ADMIN_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

function getInlineTextLimit(env) {
  return parsePositiveInt(env.INLINE_TEXT_LIMIT, DEFAULT_INLINE_TEXT_LIMIT);
}

function getPanelTextLimit(env) {
  return parsePositiveInt(env.PANEL_TEXT_LIMIT, DEFAULT_PANEL_TEXT_LIMIT);
}

function parsePositiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function safeFormString(form, key) {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function safeString(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function preview(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function html(markup, status = 200, headers = {}) {
  return new Response(markup, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...headers
    }
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: JSON_HEADERS
  });
}

function wantsJsonResponse(request) {
  const accept = request.headers.get("Accept") || "";
  const requestedWith = request.headers.get("X-Requested-With") || "";
  return accept.includes("application/json") || requestedWith.toLowerCase() === "fetch";
}

function redirect(location, headers = {}) {
  return new Response(null, {
    status: 303,
    headers: {
      Location: location,
      ...headers
    }
  });
}
