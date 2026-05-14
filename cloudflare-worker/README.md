# Cloudflare Worker Backend

This Worker receives requests from the Chrome extension, checks your extension API key, then calls an OpenAI-compatible chat completions API.

## Files

```text
cloudflare-worker/
  package.json
  wrangler.toml
  src/worker.js
```

## Install

```powershell
cd "C:\Users\ALHAMDULILLAH\Desktop\self-hosted-grammar-extension\cloudflare-worker"
npm install
```

## Add Cloudflare secrets

Set the API key that your Chrome extension must send:

```powershell
npx wrangler secret put GRAMMAR_API_KEY
```

Set your AI provider key:

```powershell
npx wrangler secret put AI_API_KEY
```

The default `wrangler.toml` uses OpenAI-compatible chat completions:

```toml
AI_API_URL = "https://api.openai.com/v1/chat/completions"
AI_MODEL = "gpt-4.1-mini"
STORE_QA_PREVIEWS = "false"
QA_RETENTION_DAYS = "30"
```

If your API is different, change those values in `wrangler.toml`.

## Deploy

```powershell
npm run deploy
```

After deploy, your extension API URL should be:

```text
https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/grammar/check
```

Current deployed Worker:

```text
https://self-hosted-grammar-worker.rony-sovware.workers.dev/grammar/check
```

In the extension popup:

```text
API URL: https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/grammar/check
API key: same value you saved as GRAMMAR_API_KEY
```

## Test

Replace the URL and token:

```powershell
$body = @{ text = "This are a sentence."; mode = "grammar"; language = "en" } | ConvertTo-Json
Invoke-RestMethod `
  -Method Post `
  -Uri "https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/grammar/check" `
  -Headers @{ Authorization = "Bearer YOUR_GRAMMAR_API_KEY" } `
  -ContentType "application/json" `
  -Body $body
```

Expected response:

```json
{
  "correctedText": "This is a sentence.",
  "suggestions": []
}
```

## QA database

The Worker is connected to this Cloudflare D1 database:

```text
database_name = "grammar-assistant-db"
database_id = "c50a86f0-4e6e-416d-bca4-4d29c663e6f3"
binding = "DB"
```

Recent QA rows are available at:

```text
GET /qa/checks?limit=25
Authorization: Bearer YOUR_GRAMMAR_API_KEY
```

Privacy defaults:

- `STORE_QA_PREVIEWS=false` stores lengths and status only, not text snippets.
- Set `STORE_QA_PREVIEWS=true` only if you need short text previews for debugging.
- `QA_RETENTION_DAYS=30` prunes older QA rows during normal request logging.
