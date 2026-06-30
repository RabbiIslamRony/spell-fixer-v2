# Grammar Assistant Chrome Extension

Chrome grammar assistant with fast inline suggestions powered by a hosted or self-hosted Cloudflare Worker. The extension stores only a Worker access token locally; AI provider keys stay encrypted in the Worker admin settings or Cloudflare secrets.

[Live Preview](https://self-hosted-grammar-worker.rony-sovware.workers.dev/) |
[Latest Extension Release](https://github.com/RabbiIslamRony/spell-fixer-v2/releases/latest) |
[Privacy Policy](https://self-hosted-grammar-worker.rony-sovware.workers.dev/privacy)

For end-user setup, see [USER_SETUP.md](./USER_SETUP.md).

## Landing Page

The public landing page is a static Next.js app in `landing/`. Build it into the Worker static assets before deploying:

```bash
npm run landing:build
```

For local landing development:

```bash
npm run landing:dev
```

## Build ZIP

Create a clean install ZIP:

```bash
npm run package
```

Output:

```text
dist/grammar-assistant-extension-v0.4.0.zip
```

The ZIP includes only Chrome runtime files and `USER_SETUP.md`. It excludes development-only items such as `.git`, `cloudflare-worker`, `server-example`, `node_modules`, `dist`, scripts, and QA docs.

## Access Model

The extension supports two Worker modes:

- `Hosted Worker`: uses `https://self-hosted-grammar-worker.rony-sovware.workers.dev/grammar/check`.
- `Custom Worker`: advanced users enter their own Worker `/grammar/check` URL and token.

Normal users paste only a Worker access token. They do not paste Gemini, Qwen, OpenAI, or other AI provider keys into Chrome.

## Admin Dashboard

The hosted Worker includes an admin dashboard:

```text
https://self-hosted-grammar-worker.rony-sovware.workers.dev/admin
```

Admin capabilities:

- Quick invite: create/reactivate a user and generate an extension token in one step.
- Revoke tokens.
- Set daily and per-minute quotas.
- Change the AI provider, model, endpoint, and API key.
- View recent usage and Worker health.

Admin login requires Cloudflare secrets:

```bash
npm --prefix cloudflare-worker run hash-password -- "your-strong-password"
cd cloudflare-worker
npx wrangler secret put ADMIN_EMAIL
npx wrangler secret put ADMIN_PASSWORD_HASH
npx wrangler secret put SESSION_SECRET
```

`ADMIN_PASSWORD_HASH` should be the generated `pbkdf2:...` value. `SESSION_SECRET` should be a separate long random secret.

Normal admin workflow:

1. Open `/admin`.
2. Use `Quick invite`.
3. Enter the user's email and quota.
4. Click `Create token`.
5. Copy the generated token immediately and send it to the user.

The token is shown only once. If a user loses it, create another token.

New tokens are also stored encrypted in D1 so the admin dashboard can reveal/copy them again from the Tokens table. Older tokens created before encrypted storage cannot be recovered; create a new token for those users.

## Worker Secrets

The Worker can use a D1 token database, the fallback `GRAMMAR_API_KEY`, or both.

Required for self-host fallback token mode:

```bash
cd cloudflare-worker
npx wrangler secret put GRAMMAR_API_KEY
```

Recommended AI setup:

1. Open `/admin`.
2. Use `AI API settings`.
3. Choose `OpenAI`, `Qwen / DashScope`, `Gemini`, or `Other OpenAI-compatible`.
4. For OpenAI, Qwen, or Gemini, the default API URL/model auto-fill when the provider changes.
5. Paste the API key.
6. For `Other OpenAI-compatible`, enter that platform's chat completions API URL and model.
7. Click `Save & test`.

The admin-saved API key is encrypted in D1 and shown only inside the private admin form after login. Saving requires an API key and overrides `AI_API_KEY` from Cloudflare secrets. The dashboard stores provider connection status as `connected`, `failed`, or `not checked`, plus a ready status.

Cloudflare secret fallback:

```bash
cd cloudflare-worker
npx wrangler secret put AI_API_KEY
```

Tracked Worker vars in `cloudflare-worker/wrangler.toml`:

```toml
AI_PROVIDER = "openai"
AI_API_URL = "https://api.openai.com/v1/chat/completions"
AI_MODEL = "gpt-4.1-mini"
STORE_QA_PREVIEWS = "false"
QA_RETENTION_DAYS = "30"
INLINE_TEXT_LIMIT = "1000"
PANEL_TEXT_LIMIT = "6000"
```

For Qwen, choose `Qwen / DashScope` and paste a DashScope key; the Worker tests both official DashScope regions and saves the working endpoint. The default model is `qwen-plus`. For Gemini, choose `Gemini`, leave the URL blank, use model `gemini-2.5-flash`, and paste a Gemini key. For other platforms, choose `Other OpenAI-compatible` and enter the platform's chat completions API URL.

## Load In Chrome

For development:

1. Open `chrome://extensions`.
2. Turn on `Developer mode`.
3. Click `Load unpacked`.
4. Select this project folder.
5. After code changes, click the extension card's `Reload` button.

For a packaged ZIP:

1. Unzip `dist/grammar-assistant-extension-v0.4.0.zip`.
2. Open `chrome://extensions`.
3. Turn on `Developer mode`.
4. Click `Load unpacked`.
5. Select the unzipped folder.

## Configure

1. Click the extension icon in Chrome.
2. Open `Advanced`.
3. Keep `Worker mode` as `Hosted Worker`, or choose `Custom Worker`.
4. For Custom Worker, paste the full `/grammar/check` URL.
5. Paste the Worker access token.
6. Click `Save settings`.
7. Click `Test`.

## Use

1. Keep `Extension` turned on in the popup.
2. Focus any text box or editable area on a website.
3. Type and pause briefly.
4. The extension underlines detected issues.
5. Use the issue tray, suggestion bubble, or `Fix all` to apply corrections.
6. Use the floating assistant button or `Ctrl+Shift+G` to open the full panel.

## Cloudflare Deploy

Apply D1 migrations before deploying a fresh Worker:

```bash
npm --prefix cloudflare-worker install
cd cloudflare-worker
npx wrangler d1 migrations apply grammar-assistant-db --remote
npm run deploy
```

The Worker also creates missing auth tables at runtime, but migrations keep deployments reproducible.

## Privacy Notes

The extension stores settings and the Worker token in Chrome local extension storage. It does not use Chrome sync for secrets.

The extension sends text from the active editor to the configured Worker only after typing pauses or the user manually runs a check. Page URLs are not sent unless `Include page URL` is enabled.

Worker QA text previews stay disabled by default with `STORE_QA_PREVIEWS=false`.

Public privacy policy URL for Chrome Web Store submission:

```text
https://self-hosted-grammar-worker.rony-sovware.workers.dev/privacy
```

Do not publish real Worker tokens or AI provider keys in GitHub, screenshots, ZIP files, or documentation.
