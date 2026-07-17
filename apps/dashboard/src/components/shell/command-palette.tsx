"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Icon } from "@/src/components/ui/icon";
import type { CatalogCommandIndex, CatalogSearchTool } from "@/src/lib/catalog";
import { searchCatalogTools } from "@/src/lib/catalog-search";
import { cn } from "@/src/lib/cn";

interface PaletteResult {
  description: string;
  href: string;
  id: string;
  kind: "Command" | "Toolkit" | "Tool";
  label: string;
}

function toolkitHref(project: string, toolkit: string, tool?: string): string {
  const parameters = new URLSearchParams({ toolkit });
  if (tool !== undefined) parameters.set("tool", tool);
  return `/${encodeURIComponent(project)}/toolkits?${parameters.toString()}`;
}

export function CommandPalette({
  catalog,
  project,
}: {
  catalog: CatalogCommandIndex;
  project: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [toolResults, setToolResults] = useState<readonly CatalogSearchTool[]>(
    [],
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActiveIndex(0);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    function openWithShortcut(event: KeyboardEvent) {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLocaleLowerCase() === "k"
      ) {
        event.preventDefault();
        setOpen((current) => {
          if (current) {
            setQuery("");
            setActiveIndex(0);
            triggerRef.current?.focus();
          }
          return !current;
        });
      }
    }
    window.addEventListener("keydown", openWithShortcut);
    return () => window.removeEventListener("keydown", openWithShortcut);
  }, []);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function handleDialogKeys(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = surfaceRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable === undefined || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    window.addEventListener("keydown", handleDialogKeys);
    return () => {
      window.removeEventListener("keydown", handleDialogKeys);
      document.body.style.overflow = previousOverflow;
    };
  }, [close, open]);

  useEffect(() => {
    const normalized = deferredQuery.trim();
    if (normalized.length === 0) {
      setToolResults([]);
      return;
    }
    let active = true;
    const controller = new AbortController();
    searchCatalogTools(normalized, controller.signal)
      .then((tools) => {
        if (active) {
          setToolResults(tools.slice(0, 10));
          setActiveIndex(0);
        }
      })
      .catch(() => {
        if (active && !controller.signal.aborted) setToolResults([]);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [deferredQuery]);

  const results = useMemo((): readonly PaletteResult[] => {
    const normalized = deferredQuery.trim().toLocaleLowerCase();
    const commands = (
      [
        {
          description: "Inspect the latest project invocation records",
          href: `/${encodeURIComponent(project)}/executions`,
          id: "command-open-executions",
          kind: "Command",
          label: "Open live executions",
        },
        {
          description: "Create an OSS fixture or hosted account connection",
          href: `/${encodeURIComponent(project)}/connections?new=true`,
          id: "command-create-connection",
          kind: "Command",
          label: "Create connection",
        },
        {
          description: "Open project access and reveal-once key creation",
          href: `/${encodeURIComponent(project)}/api-keys`,
          id: "command-create-api-key",
          kind: "Command",
          label: "Create API key",
        },
        {
          description: "Open the mock-first voice agent definition builder",
          href: `/${encodeURIComponent(project)}/voice-agents`,
          id: "command-new-voice-agent",
          kind: "Command",
          label: "New voice agent",
        },
      ] satisfies readonly PaletteResult[]
    ).filter(
      (command) =>
        normalized.length === 0 ||
        `${command.label} ${command.description}`
          .toLocaleLowerCase()
          .includes(normalized),
    );
    const toolkits = catalog.toolkits
      .filter((toolkit) => {
        if (normalized.length === 0) return true;
        return [
          toolkit.displayName,
          toolkit.slug,
          ...toolkit.capabilities.flatMap((capability) => [
            capability.slug,
            capability.label,
          ]),
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(normalized);
      })
      .slice(0, 6)
      .map(
        (toolkit): PaletteResult => ({
          description: `${toolkit.capabilities.length} capabilities / ${toolkit.sourceLabel}`,
          href: toolkitHref(project, toolkit.slug),
          id: `toolkit-${toolkit.slug}`,
          kind: "Toolkit",
          label: toolkit.displayName,
        }),
      );
    const tools = toolResults.map(
      (tool): PaletteResult => ({
        description: `${tool.capability} / schema-backed canonical tool`,
        href: toolkitHref(project, tool.toolkit, tool.name),
        id: `tool-${tool.name}`,
        kind: "Tool",
        label: tool.name,
      }),
    );
    return [...commands, ...toolkits, ...tools];
  }, [catalog.toolkits, deferredQuery, project, toolResults]);

  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        className="command-trigger"
        onClick={() => setOpen(true)}
        ref={triggerRef}
        title="Search toolkits and canonical tools"
        type="button"
      >
        <Icon name="search" />
        <span>Search or jump to</span>
        <kbd>
          <Icon name="command" />K
        </kbd>
      </button>
      {open ? (
        <div
          aria-label="Command palette"
          aria-modal="true"
          className="command-palette"
          role="dialog"
        >
          <button
            aria-label="Close command palette"
            className="command-palette__backdrop"
            onClick={close}
            type="button"
          />
          <div className="command-palette__surface" ref={surfaceRef}>
            <label className="command-palette__search">
              <Icon name="search" />
              <span className="visually-hidden">
                Search toolkits and canonical tools
              </span>
              <input
                aria-activedescendant={results[activeIndex]?.id}
                aria-autocomplete="list"
                aria-controls="command-palette-results"
                aria-expanded="true"
                onChange={(event) => {
                  setQuery(event.currentTarget.value);
                  setActiveIndex(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    close();
                  } else if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setActiveIndex((current) =>
                      Math.min(current + 1, Math.max(results.length - 1, 0)),
                    );
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setActiveIndex((current) => Math.max(current - 1, 0));
                  } else if (event.key === "Enter") {
                    const result = results[activeIndex];
                    if (result !== undefined) {
                      event.preventDefault();
                      close();
                      router.push(result.href);
                    }
                  }
                }}
                placeholder="Search Gmail, send email, calendar…"
                ref={inputRef}
                role="combobox"
                type="search"
                value={query}
              />
              <kbd>esc</kbd>
            </label>
            <div
              aria-label="Search results"
              className="command-palette__results"
              id="command-palette-results"
              role="listbox"
            >
              {results.length > 0 ? (
                results.map((result, index) => (
                  <a
                    aria-selected={activeIndex === index}
                    className={cn(
                      "command-palette__result",
                      activeIndex === index &&
                        "command-palette__result--active",
                    )}
                    href={result.href}
                    id={result.id}
                    key={result.id}
                    onClick={close}
                    onMouseEnter={() => setActiveIndex(index)}
                    role="option"
                  >
                    <span className="command-palette__kind">{result.kind}</span>
                    <span>
                      <strong
                        className={result.kind === "Tool" ? "mono" : undefined}
                      >
                        {result.label}
                      </strong>
                      <small>{result.description}</small>
                    </span>
                    <Icon name="arrowRight" />
                  </a>
                ))
              ) : (
                <div className="command-palette__empty">
                  No local catalog matches. Try a toolkit, capability, or agent
                  intent.
                </div>
              )}
            </div>
            <footer className="command-palette__footer">
              <span>
                <kbd>↑</kbd>
                <kbd>↓</kbd> navigate
              </span>
              <span>
                <kbd>↵</kbd> open
              </span>
              <span className="mono">project / {project}</span>
            </footer>
          </div>
        </div>
      ) : null}
    </>
  );
}
