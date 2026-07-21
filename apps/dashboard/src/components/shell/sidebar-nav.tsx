"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment } from "react";
import { Icon, type IconName } from "@/src/components/ui/icon";
import { cn } from "@/src/lib/cn";

interface NavItem {
  icon: IconName;
  label: string;
  section?: string;
  segment: string;
}

const navItems: readonly NavItem[] = [
  { icon: "overview", label: "Overview", segment: "overview" },
  { icon: "catalog", label: "Toolkits", segment: "toolkits" },
  { icon: "connections", label: "Connections", segment: "connections" },
  { icon: "voice", label: "Voice Agents", segment: "voice-agents" },
  { icon: "executions", label: "Executions", segment: "executions" },
  { icon: "webhook", label: "Webhooks", segment: "webhooks" },
  { icon: "connections", label: "Triggers", segment: "triggers" },
  { icon: "copy", label: "Files", segment: "files" },
  { icon: "key", label: "API Keys", segment: "api-keys" },
  { icon: "settings", label: "Settings", segment: "settings" },
];

const cloudNavItems: readonly NavItem[] = [
  ...navItems.slice(0, -1),
  {
    icon: "billing",
    label: "Billing",
    section: "Organization",
    segment: "billing",
  },
  { icon: "organization", label: "Organization", segment: "organization" },
  { icon: "activity", label: "Audit", segment: "audit" },
  navItems[navItems.length - 1] as NavItem,
];

export function SidebarNav({
  compact = false,
  cloud = false,
  organizationId,
  project,
}: {
  compact?: boolean;
  cloud?: boolean;
  organizationId?: string;
  project: string;
}) {
  const pathname = usePathname();
  const items = cloud ? cloudNavItems : navItems;
  return (
    <nav
      aria-label="Primary"
      className={cn("sidebar-nav", compact && "sidebar-nav--compact")}
    >
      {items.map((item) => {
        const href =
          cloud && item.segment === "billing" && organizationId !== undefined
            ? `/billing?org=${encodeURIComponent(organizationId)}`
            : `/${encodeURIComponent(project)}/${item.segment}`;
        const activePath = href.split("?", 1)[0] ?? href;
        const active =
          pathname === activePath || pathname.startsWith(`${activePath}/`);
        return (
          <Fragment key={item.segment}>
            {item.section ? (
              <span className="sidebar-nav__section">{item.section}</span>
            ) : null}
            <Link
              aria-current={active ? "page" : undefined}
              className={cn(
                "sidebar-nav__link",
                active && "sidebar-nav__link--active",
              )}
              href={href}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </Link>
          </Fragment>
        );
      })}
    </nav>
  );
}
