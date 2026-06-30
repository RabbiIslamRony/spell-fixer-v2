export const metadata = {
  title: "Privacy Policy - Grammar Assistant",
  description: "Privacy policy for Grammar Assistant, a self-hosted Chrome grammar extension."
};

const sections = [
  {
    title: "Data stored by the extension",
    body:
      "The extension stores settings, Worker mode, site access preferences, and a user-provided Worker access token in Chrome local extension storage on the user's device. Tokens are not stored with Chrome sync."
  },
  {
    title: "Text sent for checking",
    body:
      "When the extension is enabled, selected text or active editor text may be sent to the configured Cloudflare Worker for grammar checking. Page URL is sent only when the user turns on the Include page URL setting."
  },
  {
    title: "AI providers",
    body:
      "AI provider keys are stored in the Cloudflare Worker admin settings or Worker secrets, not in the Chrome extension. Hosted users use an access token issued by the admin. Self-hosted users control their own Worker and provider keys."
  },
  {
    title: "Landing page demo",
    body:
      "The public landing page demo is deterministic and runs in the browser. Demo text is not sent to an AI provider or the Worker API."
  },
  {
    title: "Analytics, ads, and sale of data",
    body:
      "The extension does not include advertising, affiliate tracking, analytics SDKs, or sale of user data."
  },
  {
    title: "User control",
    body:
      "Users can disable the extension, clear Worker tokens, restrict site access, or uninstall the extension at any time. Worker tokens and provider keys should be rotated if they are accidentally exposed."
  }
];

export default function PrivacyPage() {
  return (
    <main className="policy-page">
      <section className="policy-hero">
        <p className="eyebrow">Privacy policy</p>
        <h1>Grammar Assistant keeps Chrome setup token-based and user controlled.</h1>
        <p>
          This policy explains what the Chrome extension stores, what text it sends for grammar checking,
          and how the public landing page works.
        </p>
      </section>

      <section className="policy-content" aria-label="Privacy details">
        {sections.map((section) => (
          <article key={section.title}>
            <h2>{section.title}</h2>
            <p>{section.body}</p>
          </article>
        ))}
      </section>
    </main>
  );
}
