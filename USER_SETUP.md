# User Setup Guide

This guide is for people who receive the extension and only need to connect an API key.

## Quick setup

1. Open Chrome and go to `chrome://extensions`.
2. Turn on `Developer mode`.
3. Click `Load unpacked`.
4. Select the extension folder.
5. Click the extension icon in Chrome.
6. Click `Setup`.
7. Paste the Worker API key into `API key`.
8. Keep the default API URL, unless you are using your own Worker.
9. Click `Save settings`.
10. Click `Test`.

If the test passes, open any website text box and start typing. The `GA` badge appears only after you type and pause briefly.

## Site controls

Open `Advanced` in the popup if you need to control which websites can use suggestions.

- Use `All sites` for normal use.
- Use `All except listed sites` to block sensitive domains.
- Use `Only listed sites` to run suggestions only on approved domains.

Add one domain per line in `Site list`.

## What users need

For normal use, users only need:

```text
API URL: https://self-hosted-grammar-worker.rony-sovware.workers.dev/grammar/check
API key: the Worker token provided by the extension owner
```

They do not need OpenAI API keys, Cloudflare access, Wrangler, or source-code edits.

## If using their own backend

If a user self-hosts the Worker, they should replace the API URL with their own Worker endpoint:

```text
https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/grammar/check
```

The API key must match the value saved in Cloudflare as `GRAMMAR_API_KEY`.

## Troubleshooting

- `Setup needed`: no API key is saved yet.
- `Unauthorized`: the API key does not match the Worker `GRAMMAR_API_KEY`.
- `Suggestions are disabled for this site`: the current domain is blocked or not in the allowlist.
- `Open this popup from the Chrome extension toolbar`: do not open `popup.html` directly from the file system or GitHub.
- `API test passed`: the extension can reach the backend.
- No `GA` badge: click inside a text box, type text, then pause briefly.
- No red underline: wait for the check to finish, then confirm the API test still passes.

Do not publish real API keys in GitHub, screenshots, or documentation.
