# Release QA Checklist

Use this before packaging or publishing the extension.

## Static Checks

- `npm run check`
- `npm run landing:build`
- `node --check cloudflare-worker/src/worker.js`
- `node --check cloudflare-worker/scripts/hash-admin-password.mjs`
- `npm --prefix cloudflare-worker run deploy -- --dry-run`

## Worker Auth

- Apply D1 migrations from `cloudflare-worker/`: `npx wrangler d1 migrations apply grammar-assistant-db --remote`.
- Confirm `/health` returns `ok: true`.
- Confirm `/grammar/check` without `Authorization` returns `401`.
- Confirm `/grammar/check` with a valid generated user token returns `correctedText` and `issues`.
- Confirm revoked token returns `401`.
- Confirm over-quota token returns `429`.
- Confirm text above inline/panel limits returns `413`.
- Confirm `/qa/checks?limit=25` requires admin login cookie or the fallback shared token.

## Admin Dashboard

- Generate an admin password hash with `npm --prefix cloudflare-worker run hash-password -- "password"`.
- Set `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH`, and `SESSION_SECRET`.
- Visit `/admin/login`.
- Wrong password fails.
- Correct password creates an HttpOnly admin session cookie.
- Admin can save AI API settings for OpenAI, Qwen, Gemini, and custom OpenAI-compatible providers.
- Admin API settings reject an empty API key and show the saved key in the private admin input after saving.
- Admin API settings show provider connection status, checked time, and ready status after `Save & test`.
- Gemini admin test works with model `gemini-2.5-flash`.
- Qwen admin test tries both DashScope international and Beijing-compatible endpoints.
- Admin can use `Quick invite` to create/reactivate a user and see the new token once.
- Admin can click `Copy` on a new encrypted token and reveal/copy it again.
- Admin can create a user from Advanced tools.
- Admin can generate a token from Advanced tools and see it once.
- Admin can revoke a token.
- Admin can update user status and quota.
- Recent usage appears after extension checks.

## Extension Install

- Load unpacked extension from `chrome://extensions`.
- Confirm toolbar icon and extension details icon appear.
- Open the popup with no token and confirm `Setup needed` is visible.
- Open `popup.html` directly in a normal browser tab and confirm it shows a friendly extension-context message instead of a JS crash.
- Paste a hosted Worker token, save, then click `Test`.
- Switch to `Custom Worker`, paste a custom `/grammar/check` URL and token, save, then click `Test`.

## Editor Behavior

- Focus an empty text field and confirm the assistant badge does not show.
- Type text and pause briefly; confirm the badge appears after debounce.
- Type `This are a sentence.` and confirm the wrong text gets a red underline.
- Apply one suggestion and confirm remaining suggestions stay visible.
- Use `Fix all` and confirm all visible issues are replaced.
- Click outside the assistant UI and confirm bubble/panel closes.

## Settings Behavior

- Turn `Extension` off and confirm no checks run.
- Turn it on and confirm suggestions resume.
- Save a Worker token, reload the extension, and confirm the token is still saved.
- Set `All except listed sites`, add the current domain, and confirm page notice says suggestions are disabled.
- Set `Only listed sites`, add the current domain, and confirm suggestions run again.

## Marketplace Readiness

- No real Worker tokens or AI keys are committed.
- `manifest.json` includes `icons` and `action.default_icon`.
- `host_permissions` are limited to the hosted Worker origin.
- Custom Worker hosts require optional host permission at save time.
- Privacy policy is published at `https://self-hosted-grammar-worker.rony-sovware.workers.dev/privacy`.
- Privacy notes explain what text is sent, that Worker tokens use local extension storage, and that QA text previews are off by default.
- Permission justification is ready for content script access on supported websites.
