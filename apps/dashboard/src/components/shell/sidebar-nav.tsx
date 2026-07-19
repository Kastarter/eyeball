"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "@/src/components/ui/icon";
import { cn } from "@/src/lib/cn";

interface NavItem {
  icon: IconName;
  label: string;
  segment: string;
}

const navItems: readonly NavItem[] = [
  { icon: "overview", label: "Overview", segment: "overview" },
  { icon: "catalog", label: "Toolkits", segment: "toolkits" },
  { icon: "connections", label: "Connections", segment: "connections" },
  { icon: "voice", label: "Voice Agents", segment: "voice-agents" },
  { icon: "executions", label: "Executions", segment: "executions" },
  { icon: "key", label: "API Keys", segment: "api-keys" },
  { icon: "settings", label: "Settings", segment: "settings" },
];

const cloudNavItems: readonly NavItem[] = [
  ...navItems.slice(0, -1),
  { icon: "activity", label: "Audit", segment: "audit" },
  navItems[navItems.length - 1] as NavItem,
];

export function SidebarNav({
  compact = false,
  cloud = false,
  project,
}: {
  compact?: boolean;
  cloud?: boolean;
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
        const href = `/${encodeURIComponent(project)}/${item.segment}`;
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            aria-current={active ? "page" : undefined}
            className={cn(
              "sidebar-nav__link",
              active && "sidebar-nav__link--active",
            )}
            href={href}
            key={item.segment}
          >
            <Icon name={item.icon} />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
