# Cloudflare Worker Backend

This Worker serves the public landing page, the grammar API, and the built-in admin dashboard for user/token management.

Live landing page:

```text
https://self-hosted-grammar-worker.rony-sovware.workers.dev/
```

Admin dashboard:

```text
https://self-hosted-grammar-worker.rony-sovware.workers.dev/admin
```

## Install

```bash
npm install
```

## Landing Page

The public landing page is built from the Next.js app in `../landing` and exported into `cloudflare-worker/public`:

```bash
npm run --prefix .. landing:build
```

Worker admin/API routes remain in `src/worker.js`.

## D1 Migrations

```bash
npx wrangler d1 migrations apply grammar-assistant-db --remote
```

The Worker also creates missing auth tables at runtime, but migrations keep deployments reproducible.

## Admin Login Secrets

Generate a password hash:

```bash
npm run hash-password -- "your-strong-password"
```

Set required admin secrets:

```bash
npx wrangler secret put ADMIN_EMAIL
npx wrangler secret put ADMIN_PASSWORD_HASH
npx wrangler secret put SESSION_SECRET
```

Optional but recommended token pepper:

```bash
npx wrangler secret put TOKEN_SECRET
```

`ADMIN_PASSWORD_HASH` is the generated `pbkdf2:...` value. `SESSION_SECRET` and `TOKEN_SECRET` should be long random strings.

## Grammar API Tokens

Preferred hosted-user flow:

1. Log in at `/admin`.
2. Use `Quick invite`.
3. Enter the user's email, daily quota, minute quota, and optional expiry.
4. Click `Create token`.
5. Copy the token once and give it to the user.
6. User pastes it into the Chrome extension as `Worker access token`.

Use the advanced user/token tools only when you need separate user creation, manual token names, or token revocation.

New tokens are stored encrypted in D1, so the admin can use the `Copy` button in the Tokens table later. Older hash-only tokens cannot be recovered; create a new token if one is lost.

Fallback self-host flow:

```bash
npx wrangler secret put GRAMMAR_API_KEY
```

The extension can use the same value as its Worker access token. This is useful when someone deploys their own Worker and does not want the admin dashboard flow.

## AI Provider Settings

Recommended setup is from the admin dashboard:

1. Open `/admin`.
2. Use `AI API settings`.
3. Choose `OpenAI`, `Qwen / DashScope`, `Gemini`, or `Other OpenAI-compatible`.
4. For OpenAI, Qwen, or Gemini, the default API URL/model auto-fill when the provider changes.
5. Paste the provider API key.
6. For `Other OpenAI-compatible`, enter that platform's chat completions API URL and model.
7. Click `Save & test`.

Admin-saved provider keys are encrypted in D1, shown only inside the private admin form after login, and override Cloudflare secret fallback values. Saving requires an API key. The Worker performs a small provider test request and stores connection status, checked time, and ready status.

Cloudflare secret fallback:

```bash
npx wrangler secret put AI_API_KEY
```

If grammar checks fail with `AI API error: Incorrect API key`, the Chrome Worker token is not the problem. Update the provider key from `/admin`, or update the fallback Worker secret:

```bash
npx wrangler secret put AI_API_KEY
npm run deploy
```

Defaults in `wrangler.toml`:

```toml
AI_PROVIDER = "openai"
AI_API_URL = "https://api.openai.com/v1/chat/completions"
AI_MODEL = "gpt-4.1-mini"
STORE_QA_PREVIEWS = "false"
QA_RETENTION_DAYS = "30"
INLINE_TEXT_LIMIT = "1000"
PANEL_TEXT_LIMIT = "6000"
```

Qwen example:

Provider: `Qwen / DashScope`
API URL: `https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions`
Model: `qwen-plus`

The Worker also tests `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` and saves the endpoint that matches the key.

Gemini example:

Provider: `Gemini`
API URL: leave blank
Model: `gemini-2.5-flash`

Other platforms:

Provider: `Other OpenAI-compatible`
API URL: the platform's `/chat/completions` endpoint

## Deploy

```bash
npm run deploy
```

After deploy, the grammar API URL is:

```text
https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/grammar/check
```

## Test Grammar API

Replace the URL and token:

```bash
curl -sS \
  -X POST "https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/grammar/check" \
  -H "Authorization: Bearer YOUR_WORKER_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"text":"This are a sentence.","mode":"grammar","language":"en","scope":"panel"}'
```

Expected response includes:

```json
{
  "correctedText": "This is a sentence.",
  "issues": [
    {
      "original": "This are",
      "replacement": "This is"
    }
  ]
}
```

## QA Database

Recent QA rows are available at:

```text
GET /qa/checks?limit=25
Authorization: Bearer YOUR_GRAMMAR_API_KEY
```

or from an authenticated admin browser session.

Privacy defaults:

- `STORE_QA_PREVIEWS=false` stores lengths and status only, not text snippets.
- Set `STORE_QA_PREVIEWS=true` only if you need short text previews for debugging.
- `QA_RETENTION_DAYS=30` prunes older QA rows during normal request logging.
- `usage_events` stores token/user usage metadata, not full checked text.
