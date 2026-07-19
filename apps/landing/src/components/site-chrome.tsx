import { ApertureMark } from "./aperture-mark";
import { ArrowIcon, GitHubIcon } from "./icons";

export function Brand() {
  return (
    <a aria-label="eyeball.dev home" className="brand" href="/">
      <ApertureMark size={26} />
      <span className="brand__word" translate="no">
        eyeball
      </span>
      <span className="brand__domain" translate="no">
        .dev
      </span>
    </a>
  );
}

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="site-header__inner">
        <Brand />
        <nav aria-label="Primary" className="site-nav">
          <a href="#providers">Providers</a>
          <a href="#open-core">Open Core</a>
          <a className="site-nav__docs" href="/docs">
            Docs
            <ArrowIcon size={14} />
          </a>
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer__top">
        <Brand />
        <nav aria-label="Footer" className="footer-nav">
          <a href="/docs">Docs</a>
          <span
            className="footer-nav__pending"
            title="Public repository link coming soon"
          >
            <GitHubIcon size={14} />
            GitHub soon
          </span>
          <a href="/security">Security</a>
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
        </nav>
      </div>
      <div className="site-footer__bottom">
        <span>© 2026 eyeball</span>
        <span>FSL-1.1 placeholder · final license review pending</span>
      </div>
    </footer>
  );
}
