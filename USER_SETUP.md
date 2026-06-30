# User Setup Guide

This guide is for users installing the packaged Chrome extension.

## Install From ZIP

1. Unzip `grammar-assistant-extension-v0.3.9.zip`.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on `Developer mode`.
4. Click `Load unpacked`.
5. Select the unzipped extension folder.

## Add API Key

1. Click the extension icon in Chrome.
2. Click `Setup`, or open `Advanced`.
3. Choose `AI provider`.
4. Paste the matching API key into `API key`.
5. Click `Save settings`.
6. Click `Test`.

Use:

- `Qwen` for a DashScope Qwen API key.
- `Gemini` for a Gemini API key.
- `External API` only if you have a custom grammar API URL.

For normal Qwen/Gemini use, leave `External API URL` blank. It is only needed when `External API` is selected.

API keys are saved only in Chrome local extension storage on this device. They are not saved with Chrome sync.

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

- `Setup needed`: no API key is saved yet.
- `Add your Qwen API key`: choose Qwen and paste a valid DashScope key.
- `Qwen API key is invalid`: the key is wrong or belongs to another DashScope region.
- `Suggestions are disabled for this site`: the current domain is blocked or not in the allowlist.
- No `GA` badge: click inside a text box, type text, then pause briefly.
- No red underline: click `Test` in the popup and reload the extension from `chrome://extensions`.

Do not share real API keys in screenshots, chats, GitHub, or documentation.
