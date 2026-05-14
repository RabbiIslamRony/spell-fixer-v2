# Self Hosted Grammar Assistant

This is an original Chrome extension that sends selected text, or the full active text box, to your own grammar API. It does not use Grammarly code, assets, branding, or private behavior.

For end-user API-key setup, see [USER_SETUP.md](./USER_SETUP.md).

## Load in Chrome

1. Open `chrome://extensions`.
2. Turn on `Developer mode`.
3. Click `Load unpacked`.
4. Select this folder:

```text
C:\Users\ALHAMDULILLAH\Desktop\self-hosted-grammar-extension
```

## Configure

The extension is prefilled with your deployed Worker URL, but API keys are not committed to source control:

```text
API URL: https://self-hosted-grammar-worker.rony-sovware.workers.dev/grammar/check
API key: add your own Worker token in the popup
Language: en
```

Open the extension popup, expand `Advanced`, paste the same token saved in Cloudflare as `GRAMMAR_API_KEY`, then click `Save settings` and `Test`.

Other users do not need source-code changes. They can click `Setup` in the popup, paste the Worker API key, save, and test.

For a Cloudflare Worker deployment, use:

```text
API URL: https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/grammar/check
API key: the same value saved in Cloudflare as GRAMMAR_API_KEY
```

Current deployed Worker:

```text
https://self-hosted-grammar-worker.rony-sovware.workers.dev/grammar/check
```

## Use

1. Open the extension popup and keep `Extension` turned on.
2. Focus any text box or editable area on a website.
3. Start typing. The floating `GA` button stays hidden until typing pauses for a moment.
4. Wait briefly after typing. Invalid words or phrases get a red underline.
5. Use the small issue tray near the text box to apply individual fixes or `Fix all`.
6. Click inside an underlined issue, or select the word, to open a suggestion bubble.
7. Click outside the assistant UI to hide the suggestion bubble or full panel.
8. You can still click the floating `GA` button or press `Ctrl+Shift+G` to open the full panel.

## Pause suggestions

Open the extension popup and turn `Extension` off. While it is off, the extension stops checking text, hides inline UI, and blocks page checks without changing your API settings. Turn it back on from the same popup when you want live suggestions again.

## API contract

The extension sends this request:

```json
{
  "text": "This are a sentence.",
  "mode": "grammar",
  "language": "en",
  "pageUrl": "https://example.com",
  "context": ""
}
```

Return this shape:

```json
{
  "correctedText": "This is a sentence.",
  "issues": [
    {
      "start": 5,
      "end": 8,
      "original": "are",
      "replacement": "is",
      "title": "Subject verb agreement",
      "explanation": "Use 'is' with singular 'This'.",
      "severity": "grammar"
    }
  ],
  "suggestions": [
    {
      "title": "Subject verb agreement",
      "replacement": "This is a sentence.",
      "explanation": "Use 'is' with singular 'This'.",
      "severity": "grammar"
    }
  ]
}
```

The extension also accepts `corrected_text`, `replacement`, or `text` as fallback response keys.

## Local server example

Run:

```powershell
cd "C:\Users\ALHAMDULILLAH\Desktop\self-hosted-grammar-extension\server-example"
node .\server.js
```

Then set the extension API URL to:

```text
http://127.0.0.1:8787/grammar/check
```

The example server works without dependencies. If you set `AI_API_URL`, `AI_API_KEY`, and `AI_MODEL`, it will call an OpenAI-compatible chat completions API. Without those values, it returns a small deterministic demo correction.

## Cloudflare Worker backend

I added a Worker template here:

```text
C:\Users\ALHAMDULILLAH\Desktop\self-hosted-grammar-extension\cloudflare-worker
```

Setup:

```powershell
cd "C:\Users\ALHAMDULILLAH\Desktop\self-hosted-grammar-extension\cloudflare-worker"
npm install
npx wrangler secret put GRAMMAR_API_KEY
npx wrangler secret put AI_API_KEY
npm run deploy
```

`GRAMMAR_API_KEY` is the private token your Chrome extension sends as `Authorization: Bearer ...`.
`AI_API_KEY` is your OpenAI-compatible provider key used only inside Cloudflare Worker.
