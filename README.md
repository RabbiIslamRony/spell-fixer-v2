# Grammar Assistant Chrome Extension

Chrome grammar assistant with direct Qwen/Gemini API key support. A user can choose `Qwen` or `Gemini` in the popup, paste that provider API key, and use the extension without Cloudflare or source-code edits.

For end-user setup, see [USER_SETUP.md](./USER_SETUP.md).

## Build ZIP

Create a clean install ZIP:

```bash
npm run package
```

Output:

```text
dist/grammar-assistant-extension-v0.3.8.zip
```

The ZIP includes only Chrome runtime files and `USER_SETUP.md`. It excludes development-only items such as `.git`, `cloudflare-worker`, `server-example`, `node_modules`, `dist`, scripts, and QA docs.

## Landing Page

The public landing page lives in `cloudflare-worker/public/` and is served by the Cloudflare Worker static assets binding. It includes a browser-only demo, so visitor demo text is not sent to Qwen, Gemini, or the Worker API.

The landing page links to GitHub Releases for installation. The extension ZIP is not copied into the Cloudflare static assets folder.

## Load in Chrome

For development:

1. Open `chrome://extensions`.
2. Turn on `Developer mode`.
3. Click `Load unpacked`.
4. Select this project folder.
5. After code changes, click the extension card's `Reload` button.

For a packaged ZIP:

1. Unzip `dist/grammar-assistant-extension-v0.3.8.zip`.
2. Open `chrome://extensions`.
3. Turn on `Developer mode`.
4. Click `Load unpacked`.
5. Select the unzipped folder.

## Configure

1. Click the extension icon in Chrome.
2. Open `Advanced`.
3. Select `AI provider`.
4. Paste the matching API key.
5. Click `Save settings`.
6. Click `Test`.

Provider defaults:

- `Qwen`: DashScope `qwen-plus`; Singapore endpoint is tried first.
- `Gemini`: Gemini `gemini-3.5-flash`.
- `External API`: optional custom API URL using the extension's original grammar API contract.

`API URL` stays hidden and blank unless `External API` is selected.

## Use

1. Keep `Extension` turned on in the popup.
2. Focus any text box or editable area on a website.
3. Type and pause briefly.
4. The extension underlines detected issues.
5. Use the issue tray, suggestion bubble, or `Fix all` to apply corrections.
6. Use the floating `GA` button or `Ctrl+Shift+G` to open the full panel.

## Site Access

Open `Advanced` in the popup:

- `All sites`: check text on any supported website.
- `All except listed sites`: disable suggestions on listed domains.
- `Only listed sites`: run suggestions only on approved domains.

Put one domain per line in `Site list`, for example `example.com` or `docs.example.com`.

## Privacy Notes

The extension sends text from the active editor to the selected provider only after typing pauses or the user manually runs a check. Page URLs are not sent unless `Include page URL` is enabled.

Do not publish real API keys in GitHub, screenshots, ZIP files, or documentation.
