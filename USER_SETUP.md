# User Setup Guide

This guide is for users installing the packaged Chrome extension.

## Install From ZIP

1. Unzip `grammar-assistant-extension-v0.4.0.zip`.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on `Developer mode`.
4. Click `Load unpacked`.
5. Select the unzipped extension folder.

## Connect Worker

For normal hosted use:

1. Click the extension icon in Chrome.
2. Click `Setup`, or open `Advanced`.
3. Keep `Worker mode` set to `Hosted Worker`.
4. Paste the Worker access token you received from the admin.
5. Click `Save settings`.
6. Click `Test`.

For self-hosted use:

1. Deploy your own Cloudflare Worker.
2. Set your Worker access secret, such as `GRAMMAR_API_KEY`.
3. Add your AI provider key from the Worker `/admin` dashboard, or set `AI_API_KEY` as a Cloudflare secret.
4. In the extension popup, open `Advanced`.
5. Change `Worker mode` to `Custom Worker`.
6. Paste your full `/grammar/check` URL.
7. Paste the same token you saved as `GRAMMAR_API_KEY`.
8. Click `Save settings`, then `Test`.

AI provider keys are not stored in Chrome. They stay encrypted in the Worker admin settings or in Cloudflare Worker secrets.
The Worker admin page requires an AI provider key before saving provider settings.

Recommended provider models:

- Gemini: `gemini-2.5-flash`
- Qwen / DashScope: `qwen-plus`

## Use The Extension

1. Keep `Extension` turned on.
2. Open any website with a text box.
3. Type text and pause briefly.
4. Apply suggestions from the underline popup, issue tray, or `Fix all`.

## Site Controls

Open `Advanced` if you need to control where suggestions run.

- `All sites`: normal use.
- `All except listed sites`: block sensitive domains.
- `Only listed sites`: allow only approved domains.

Add one domain per line in `Site list`.

## Troubleshooting

- `Setup needed`: no Worker access token is saved yet.
- `Add your Worker access token`: paste a valid hosted or self-hosted Worker token.
- `Worker access token is invalid, expired, or revoked`: ask the admin for a new token, or update your self-hosted `GRAMMAR_API_KEY`.
- `Daily usage limit reached`: your token quota is used up.
- `Suggestions are disabled for this site`: the current domain is blocked or not in the allowlist.
- No assistant badge: click inside a text box, type text, then pause briefly.
- No red underline: click `Test` in the popup and reload the extension from `chrome://extensions`.

Do not share real Worker tokens or AI provider keys in screenshots, chats, GitHub, or documentation.
