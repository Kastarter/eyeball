import Link from "next/link";
import type { ReactNode } from "react";
import type { DocsConfig, SearchRecord } from "../lib/content";
import { ApertureLogo } from "./aperture-logo";
import { Icon } from "./icon";
import { MobileNavigation } from "./mobile-navigation";
import { DocsSearch } from "./search";
import { SidebarNavigation } from "./sidebar-navigation";
import { ThemeToggle } from "./theme-toggle";

interface DocsShellProps {
  children: ReactNode;
  config: DocsConfig;
  searchIndex: SearchRecord[];
  titles: Record<string, string>;
}

export function DocsShell({
  children,
  config,
  searchIndex,
  titles,
}: DocsShellProps) {
  const sidebar = (
    <SidebarNavigation navigation={config.navigation} titles={titles} />
  );

  return (
    <div className="docs-site">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar__inner">
          <div className="topbar__brand-wrap">
            <MobileNavigation>{sidebar}</MobileNavigation>
            <Link
              aria-label="eyeball documentation home"
              className="brand"
              href="/"
              translate="no"
            >
              <ApertureLogo size={26} watching />
              <span className="brand__wordmark">eyeball</span>
              <span className="brand__product">docs</span>
            </Link>
          </div>
          <div className="topbar__search">
            <DocsSearch records={searchIndex} />
          </div>
          <div className="topbar__actions">
            <nav aria-label="Primary" className="topbar__links">
              <Link className="topbar-link" href="/getting-started/quickstart">
                Quickstart
              </Link>
              <Link className="topbar-link" href="/api/overview">
                API Reference
              </Link>
            </nav>
            <ThemeToggle />
            <a
              aria-label="eyeball on GitHub"
              className="icon-button"
              href="https://github.com/eyeball-ai/eyeball"
              rel="noreferrer"
              target="_blank"
              title="GitHub"
            >
              <Icon name="github" size={18} />
            </a>
          </div>
        </div>
      </header>

      <div className="docs-grid">
        <aside aria-label="Documentation navigation" className="docs-sidebar">
          <div className="docs-sidebar__scroll">{sidebar}</div>
        </aside>
        {children}
      </div>
    </div>
  );
}
