const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: JSON_HEADERS });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        service: "self-hosted-grammar-worker",
        database: Boolean(env.DB)
      });
    }

    if (request.method === "GET" && url.pathname === "/qa/checks") {
      const authError = validateApiKey(request, env);
      if (authError) {
        return json({ error: authError }, 401);
      }

      return getQaChecks(url, env);
    }

    if (request.method !== "POST" || url.pathname !== "/grammar/check") {
      return json({ error: "Not found" }, 404);
    }

    const authError = validateApiKey(request, env);
    if (authError) {
      return json({ error: authError }, 401);
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const text = String(payload.text || "").trim();
    if (!text) {
      return json({ error: "Missing text" }, 400);
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
        env
      });

      ctx.waitUntil(recordGrammarCheck(env, {
        mode,
        language,
        pageUrl,
        inputText: text,
        correctedText: result.correctedText,
        suggestionCount: Math.max(result.issues?.length || 0, result.suggestions?.length || 0),
        success: true,
        error: ""
      }));

      return json(result);
    } catch (error) {
      ctx.waitUntil(recordGrammarCheck(env, {
        mode: safeString(payload.mode, "grammar"),
        language: safeString(payload.language, "en"),
        pageUrl: safeString(payload.pageUrl, ""),
        inputText: text,
        correctedText: "",
        suggestionCount: 0,
        success: false,
        error: error instanceof Error ? error.message : "Grammar check failed"
      }));

      return json(
        { error: error instanceof Error ? error.message : "Grammar check failed" },
        500
      );
    }
  }
};

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

function validateApiKey(request, env) {
  if (!env.GRAMMAR_API_KEY) {
    return null;
  }

  const authorization = request.headers.get("Authorization") || "";
  const expected = `Bearer ${env.GRAMMAR_API_KEY}`;

  if (authorization !== expected) {
    return "Invalid API key";
  }

  return null;
}

async function recordGrammarCheck(env, event) {
  if (!env.DB) {
    return;
  }

  try {
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
        preview(event.inputText || ""),
        preview(event.correctedText || "")
      )
      .run();
  } catch (error) {
    console.warn("Failed to record grammar check", error);
  }
}

async function checkText({ text, mode, language, pageUrl, env }) {
  if (!env.AI_API_KEY) {
    return demoCheck(text, mode);
  }

  const prompt = buildPrompt({ text, mode, language, pageUrl });
  const response = await fetch(env.AI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.AI_API_KEY}`
    },
    body: JSON.stringify({
      model: env.AI_MODEL || "gpt-4.1-mini",
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
    throw new Error(`AI API error: ${detail}`);
  }

  const content = data?.choices?.[0]?.message?.content || "";
  return normalizeModelResponse(content, text);
}

function buildPrompt({ text, mode, language, pageUrl }) {
  return JSON.stringify({
    task: mode,
    language,
    pageUrl,
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

function safeString(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function preview(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: JSON_HEADERS
  });
}
