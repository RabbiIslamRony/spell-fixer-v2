const releaseUrl = "https://github.com/RabbiIslamRony/spell-fixer-v2/releases/latest";

export function SiteHeader() {
  return (
    <header className="site-header">
      <a className="brand" href="/" aria-label="Grammar Assistant home">
        <img src="/assets/logo-48.png" width="40" height="40" alt="" />
        <span>Grammar Assistant</span>
      </a>
      <nav aria-label="Primary navigation">
        <a href="/#demo">Demo</a>
        <a href="/#setup">Access</a>
        <a href="/privacy">Privacy</a>
        <a className="nav-cta" href={releaseUrl}>Install</a>
      </nav>
    </header>
  );
}
