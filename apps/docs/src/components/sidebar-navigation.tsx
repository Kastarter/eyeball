import Link from "next/link";
import type { NavigationEntry, NavigationGroup } from "../lib/content";
import { pathToHref } from "../lib/content";
import { Icon } from "./icon";

interface SidebarNavigationProps {
  currentPath: string;
  navigation: NavigationGroup[];
  titles: Record<string, string>;
}

function containsPath(
  entries: NavigationEntry[],
  currentPath: string,
): boolean {
  return entries.some((entry) =>
    typeof entry === "string"
      ? entry === currentPath
      : containsPath(entry.pages, currentPath),
  );
}

function NavigationEntries({
  currentPath,
  entries,
  level,
  titles,
}: {
  currentPath: string;
  entries: NavigationEntry[];
  level: number;
  titles: Record<string, string>;
}) {
  return (
    <ul className={`sidebar-list sidebar-list--level-${level}`}>
      {entries.map((entry) => {
        if (typeof entry === "string") {
          const active = entry === currentPath;
          return (
            <li key={entry}>
              <Link
                aria-current={active ? "page" : undefined}
                className={active ? "sidebar-link is-active" : "sidebar-link"}
                href={pathToHref(entry)}
              >
                <span>{titles[entry] ?? entry}</span>
              </Link>
            </li>
          );
        }

        const open = containsPath(entry.pages, currentPath);
        return (
          <li className="sidebar-subgroup" key={entry.group}>
            <details open={open}>
              <summary>
                <span>{entry.group}</span>
                <Icon name="chevron-right" size={13} />
              </summary>
              <NavigationEntries
                currentPath={currentPath}
                entries={entry.pages}
                level={level + 1}
                titles={titles}
              />
            </details>
          </li>
        );
      })}
    </ul>
  );
}

export function SidebarNavigation({
  currentPath,
  navigation,
  titles,
}: SidebarNavigationProps) {
  return (
    <nav aria-label="Documentation" className="sidebar-navigation">
      {navigation.map((group) => {
        const open = containsPath(group.pages, currentPath);
        return (
          <details className="sidebar-group" key={group.group} open={open}>
            <summary>
              <span>{group.group}</span>
              <Icon name="chevron-right" size={13} />
            </summary>
            <NavigationEntries
              currentPath={currentPath}
              entries={group.pages}
              level={1}
              titles={titles}
            />
          </details>
        );
      })}
    </nav>
  );
}
