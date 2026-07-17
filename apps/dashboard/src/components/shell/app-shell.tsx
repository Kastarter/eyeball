import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "@/src/components/ui/icon";
import { StatusDot } from "@/src/components/ui/status-dot";
import { getCatalogCommandIndex } from "@/src/lib/catalog";
import { ApertureLogo } from "./aperture-logo";
import { CommandPalette } from "./command-palette";
import { SidebarNav } from "./sidebar-nav";
import { ThemeToggle } from "./theme-toggle";

function projectLabel(project: string): string {
  return project
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

export interface AppShellProps {
  children: ReactNode;
  project: string;
}

export function AppShell({ children, project }: AppShellProps) {
  const label = projectLabel(project) || "Untitled project";
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="sidebar">
        <Link
          aria-label="eyeball overview"
          className="brand"
          href={`/${project}/overview`}
        >
          <ApertureLogo watching />
          <span className="brand__wordmark">eyeball</span>
        </Link>
        <button className="project-switcher" type="button">
          <span className="project-switcher__mark">{label.slice(0, 1)}</span>
          <span className="project-switcher__copy">
            <span>{label}</span>
            <span className="mono">prj_{project.slice(0, 8)}</span>
          </span>
          <Icon name="chevronDown" />
        </button>
        <SidebarNav project={project} />
        <div className="sidebar__footer">
          <Link className="sidebar__utility" href="/design">
            <Icon name="catalog" />
            Design system
          </Link>
          <span className="sidebar__version mono">dashboard / 0.1</span>
        </div>
      </aside>

      <div className="app-frame">
        <header className="topbar">
          <details className="mobile-nav">
            <summary>
              <ApertureLogo size={24} watching />
              <span>{label}</span>
              <Icon name="chevronDown" />
            </summary>
            <SidebarNav compact project={project} />
          </details>
          <div className="topbar__context">
            <span className="topbar__project">{label}</span>
            <span aria-hidden="true" className="topbar__divider">
              /
            </span>
            <span className="environment-badge">
              <StatusDot pulse tone="accent" />
              Production
            </span>
          </div>
          <div className="topbar__actions">
            <CommandPalette
              catalog={getCatalogCommandIndex()}
              project={project}
            />
            <ThemeToggle />
            <button
              aria-label="Open account menu"
              className="avatar"
              type="button"
            >
              KS
            </button>
          </div>
        </header>
        <main className="main-content" id="main-content">
          {children}
        </main>
      </div>
    </div>
  );
}
