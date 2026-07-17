import Link from "next/link";
import type { ReactNode } from "react";
import type {
  AdjacentPage,
  DocsConfig,
  PageHeading,
  SearchRecord,
} from "../lib/content";
import { ApertureLogo } from "./aperture-logo";
import { Icon } from "./icon";
import { MobileNavigation } from "./mobile-navigation";
import { OnThisPage } from "./on-this-page";
import { DocsSearch } from "./search";
import { SidebarNavigation } from "./sidebar-navigation";
import { ThemeToggle } from "./theme-toggle";

interface DocsShellProps {
  children: ReactNode;
  config: DocsConfig;
  currentPath: string;
  description: string;
  headings: PageHeading[];
  next: AdjacentPage | undefined;
  previous: AdjacentPage | undefined;
  searchIndex: SearchRecord[];
  title: string;
  titles: Record<string, string>;
}

function AdjacentLink({
  direction,
  page,
}: {
  direction: "next" | "previous";
  page: AdjacentPage;
}) {
  return (
    <Link
      className={`page-nav-link page-nav-link--${direction}`}
      href={page.path}
    >
      {direction === "previous" ? <Icon name="chevron-left" size={17} /> : null}
      <span>
        <small>{direction === "previous" ? "Previous" : "Next"}</small>
        <strong>{page.title}</strong>
      </span>
      {direction === "next" ? <Icon name="chevron-right" size={17} /> : null}
    </Link>
  );
}

export function DocsShell({
  children,
  config,
  currentPath,
  description,
  headings,
  next,
  previous,
  searchIndex,
  title,
  titles,
}: DocsShellProps) {
  const sidebar = (
    <SidebarNavigation
      currentPath={currentPath}
      navigation={config.navigation}
      titles={titles}
    />
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

        <main className="docs-main" id="main-content">
          <article>
            <header className="page-header">
              <div className="page-header__eyebrow">
                <span />
                {config.name} documentation
              </div>
              <h1>{title}</h1>
              <p>{description}</p>
            </header>
            <div className="prose">{children}</div>
            <footer className="page-footer">
              <div className="page-footer__links">
                {previous ? (
                  <AdjacentLink direction="previous" page={previous} />
                ) : (
                  <span />
                )}
                {next ? (
                  <AdjacentLink direction="next" page={next} />
                ) : (
                  <span />
                )}
              </div>
              <div className="page-footer__meta">
                <span>Built from the repository’s authored MDX.</span>
                <a
                  href="https://github.com/eyeball-ai/eyeball"
                  rel="noreferrer"
                  target="_blank"
                >
                  View source <Icon name="chevron-right" size={13} />
                </a>
              </div>
            </footer>
          </article>
        </main>

        <aside className="docs-toc">
          <OnThisPage headings={headings} />
        </aside>
      </div>
    </div>
  );
}
