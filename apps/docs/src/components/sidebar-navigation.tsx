"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type RefObject, useEffect, useRef } from "react";
import type { NavigationEntry, NavigationGroup } from "../lib/content";
import { Icon } from "./icon";

interface SidebarNavigationProps {
  navigation: NavigationGroup[];
  titles: Record<string, string>;
}

function pathToHref(docPath: string): string {
  return docPath === "index" ? "/" : `/${docPath}`;
}

function pathnameToDocPath(pathname: string): string {
  const docPath = pathname.replace(/^\/+|\/+$/g, "");
  return docPath || "index";
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
  activeLinkRef,
  entries,
  level,
  titles,
}: {
  currentPath: string;
  activeLinkRef: RefObject<HTMLAnchorElement | null>;
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
                ref={active ? activeLinkRef : undefined}
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
                activeLinkRef={activeLinkRef}
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
  navigation,
  titles,
}: SidebarNavigationProps) {
  const currentPath = pathnameToDocPath(usePathname());
  const activeLinkRef = useRef<HTMLAnchorElement>(null);
  const didAutoScrollRef = useRef(false);

  useEffect(() => {
    const activeLink = activeLinkRef.current;
    if (
      !activeLink ||
      activeLink.getAttribute("href") !== pathToHref(currentPath)
    ) {
      return;
    }

    let details = activeLink.closest("details");
    while (details) {
      details.open = true;
      details = details.parentElement?.closest("details") ?? null;
    }

    if (!didAutoScrollRef.current) {
      didAutoScrollRef.current = true;
      activeLink.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [currentPath]);

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
              activeLinkRef={activeLinkRef}
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
