import { LiveDemo } from "./components/LiveDemo";

const releaseUrl = "https://github.com/RabbiIslamRony/spell-fixer-v2/releases/latest";

export default function HomePage() {
  return (
    <main>
      <section className="hero" id="demo">
        <div className="hero-copy">
          <p className="eyebrow">Fully self-hosted Chrome grammar assistant</p>
          <h1>Fix grammar where you type.</h1>
          <p className="hero-text">
            Inline suggestions, one-click fixes, and Worker-token setup from the extension popup.
            Provider keys stay in your hosted or self-hosted Cloudflare Worker.
          </p>
          <div className="hero-actions" aria-label="Primary actions">
            <a className="button primary" href={releaseUrl}>Download extension</a>
            <a className="button secondary" href="#setup">Setup access</a>
          </div>
        </div>

        <LiveDemo />
      </section>

      <section className="info-band" id="privacy">
        <div>
          <h2>Public demo, private by default.</h2>
          <p>This page runs a deterministic browser demo only. Demo text is not sent to an AI provider.</p>
        </div>
        <div>
          <h2>No ZIP in the landing page.</h2>
          <p>Installation files stay in GitHub Releases, keeping the Cloudflare site lightweight.</p>
        </div>
        <div>
          <h2>Hosted or self-hosted access.</h2>
          <p>Users paste a Worker access token. Advanced users can enter their own Worker URL and token.</p>
        </div>
      </section>

      <section className="setup-band" id="setup" aria-labelledby="selfHostedTitle">
        <div className="setup-copy">
          <p className="eyebrow">Self-hosted by design</p>
          <h2 id="selfHostedTitle">Your Worker, your provider keys, your control.</h2>
          <p>
            Grammar Assistant keeps AI provider keys out of Chrome. Use the hosted Worker with an access token,
            or deploy your own Cloudflare Worker and keep Gemini, Qwen, OpenAI-compatible, or other provider keys
            in the Worker admin dashboard.
          </p>
        </div>

        <div className="setup-steps" aria-label="Worker access setup">
          <article className="setup-step">
            <span className="step-number">1</span>
            <h3>Hosted Worker</h3>
            <p>Ask the admin for a Worker access token, install the extension, and paste the token once.</p>
            <a href={releaseUrl}>Install extension</a>
          </article>

          <article className="setup-step">
            <span className="step-number">2</span>
            <h3>Self-hosted Worker</h3>
            <p>Deploy the Worker, set your access token, then paste the Worker URL and token in the extension.</p>
            <a href="https://developers.cloudflare.com/workers/wrangler/install-and-update/">Install Wrangler</a>
          </article>

          <article className="setup-step">
            <span className="step-number">3</span>
            <h3>Use free provider quota</h3>
            <p>Save free-tier Gemini, Qwen, or OpenAI-compatible provider keys from the Worker admin page.</p>
            <a href="https://aistudio.google.com/app/apikey">Gemini key page</a>
          </article>
        </div>
      </section>
    </main>
  );
}
