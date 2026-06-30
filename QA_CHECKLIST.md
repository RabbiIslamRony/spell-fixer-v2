# Release QA Checklist

Use this before packaging or selling the extension.

## Static checks

- `node --check content.js`
- `node --check popup.js`
- `node --check background.js`
- `node --check cloudflare-worker/src/worker.js`
- `npm --prefix cloudflare-worker run deploy -- --dry-run`

## Extension install

- Load unpacked extension from `chrome://extensions`.
- Confirm the toolbar icon and extension details icon appear.
- Open the popup with no API key and confirm `Setup needed` is visible.
- Open `popup.html` directly in a normal browser tab and confirm it shows a friendly extension-context message instead of a JS crash.
- Click `Setup`, paste a Worker API key, save, then click `Test`.

## Editor behavior

- Focus an empty text field and confirm the `GA` badge does not show.
- Type text and pause briefly; confirm the `GA` badge appears after debounce.
- Type `This are a sentence.` and confirm the wrong text gets a red underline.
- Apply one suggestion and confirm remaining suggestions stay visible.
- Use `Fix all` and confirm all visible issues are replaced.
- Click outside the assistant UI and confirm bubble/panel closes.

## Settings behavior

- Turn `Extension` off and confirm no checks run.
- Turn it on and confirm suggestions resume.
- Save an API key, reload the extension, and confirm the key is still saved.
- Set `All except listed sites`, add the current domain, and confirm page notice says suggestions are disabled.
- Set `Only listed sites`, add the current domain, and confirm suggestions run again.

## Worker behavior

- `GET /health` returns `ok: true`.
- `/grammar/check` without an API key returns `401`.
- `/grammar/check` with the correct API key returns `correctedText` and `issues`.
- `/qa/checks?limit=25` works with the correct API key.
- Confirm D1 QA rows do not store text previews unless `STORE_QA_PREVIEWS=true`.

## Marketplace readiness

- No real API keys are committed.
- `manifest.json` includes `icons` and `action.default_icon`.
- Privacy policy is published at `https://self-hosted-grammar-worker.rony-sovware.workers.dev/privacy`.
- Privacy notes explain what text is sent, that API keys use local extension storage, and what QA metadata is stored.
- Permission justification is ready for content script access on supported websites.
- `host_permissions` are limited to Gemini and DashScope provider endpoints.
