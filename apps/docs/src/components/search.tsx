"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type KeyboardEvent,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { SearchRecord } from "../lib/content";
import { Icon } from "./icon";

interface ScoredRecord {
  record: SearchRecord;
  score: number;
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0;
  for (const character of haystack) {
    if (character === needle[index]) {
      index += 1;
      if (index === needle.length) {
        return true;
      }
    }
  }
  return needle.length > 1 && index === needle.length;
}

function scoreRecord(record: SearchRecord, query: string): number {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) {
    return 1;
  }

  const title = normalize(record.title);
  const headings = normalize(record.headings.join(" "));
  const excerpt = normalize(record.excerpt);
  const haystack = `${title} ${headings} ${excerpt}`;
  const tokens = normalizedQuery.split(/\s+/);
  let score = title === normalizedQuery ? 160 : 0;

  for (const token of tokens) {
    if (title.startsWith(token)) {
      score += 48;
    } else if (title.includes(token)) {
      score += 32;
    } else if (headings.includes(token)) {
      score += 18;
    } else if (excerpt.includes(token)) {
      score += 8;
    } else if (isSubsequence(token, title)) {
      score += 4;
    } else {
      return 0;
    }
  }

  if (haystack.includes(normalizedQuery)) {
    score += 20;
  }
  return score;
}

export function DocsSearch({ records }: { records: SearchRecord[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const deferredQuery = useDeferredValue(query);
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const router = useRouter();

  const results = useMemo(() => {
    const scored: ScoredRecord[] = [];
    for (const record of records) {
      const score = scoreRecord(record, deferredQuery);
      if (score > 0) {
        scored.push({ record, score });
      }
    }
    return scored
      .sort(
        (a, b) =>
          b.score - a.score || a.record.title.localeCompare(b.record.title),
      )
      .slice(0, 9)
      .map(({ record }) => record);
  }, [deferredQuery, records]);

  const selectedIndex =
    results.length === 0 ? -1 : Math.min(activeIndex, results.length - 1);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActiveIndex(0);
  }, []);

  const openSearch = useCallback(() => setOpen(true), []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (open) {
          close();
        } else {
          openSearch();
        }
      } else if (event.key === "Escape" && open) {
        close();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close, open, openSearch]);

  useEffect(() => {
    if (!open) {
      return;
    }

    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : triggerRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const animationFrame = window.requestAnimationFrame(() =>
      inputRef.current?.focus(),
    );
    return () => {
      window.cancelAnimationFrame(animationFrame);
      document.body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [open]);

  function handleDialogKeys(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Tab") {
      return;
    }

    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ??
        [],
    );
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) {
      event.preventDefault();
      return;
    }

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function handleListKeys(event: KeyboardEvent<HTMLInputElement>) {
    if (results.length === 0) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => Math.min(current + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter") {
      const selected = results[selectedIndex];
      if (selected) {
        event.preventDefault();
        router.push(selected.path);
        close();
      }
    }
  }

  return (
    <>
      <button
        aria-controls="docs-search-dialog"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Search documentation"
        className="search-trigger"
        onClick={openSearch}
        ref={triggerRef}
        type="button"
      >
        <Icon name="search" size={16} />
        <span>Search docs…</span>
        <kbd>⌘K</kbd>
      </button>
      {open ? (
        <div className="search-dialog" role="presentation">
          <button
            aria-label="Close search"
            className="search-dialog__backdrop"
            onClick={close}
            tabIndex={-1}
            type="button"
          />
          <section
            aria-label="Search documentation"
            aria-modal="true"
            className="search-dialog__surface"
            id="docs-search-dialog"
            onKeyDown={handleDialogKeys}
            ref={dialogRef}
            role="dialog"
          >
            <div className="search-dialog__input-wrap">
              <Icon name="search" size={18} />
              <input
                aria-activedescendant={
                  results[selectedIndex]
                    ? `search-result-${selectedIndex}`
                    : undefined
                }
                aria-autocomplete="list"
                aria-controls="docs-search-results"
                aria-expanded="true"
                aria-label="Search documentation"
                autoComplete="off"
                name="docs-search"
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveIndex(0);
                }}
                onKeyDown={handleListKeys}
                placeholder="Search guides, APIs, and toolkits…"
                ref={inputRef}
                role="combobox"
                spellCheck={false}
                value={query}
              />
              <button
                aria-label="Close search"
                className="search-close"
                onClick={close}
                type="button"
              >
                <span>Esc</span>
              </button>
            </div>
            <div className="search-dialog__body">
              <p aria-live="polite" className="search-dialog__label">
                {query ? "Best matches" : "Explore documentation"}
              </p>
              {results.length > 0 ? (
                <div
                  className="search-results"
                  id="docs-search-results"
                  role="listbox"
                >
                  {results.map((result, index) => (
                    <div
                      className="search-result"
                      key={result.path}
                      role="presentation"
                    >
                      <Link
                        aria-selected={selectedIndex === index}
                        className={
                          selectedIndex === index ? "is-active" : undefined
                        }
                        href={result.path}
                        id={`search-result-${index}`}
                        onClick={close}
                        onMouseEnter={() => setActiveIndex(index)}
                        role="option"
                      >
                        <span className="search-result__icon">
                          <Icon name="search" size={15} />
                        </span>
                        <span className="search-result__copy">
                          <strong>{result.title}</strong>
                          <small>
                            {result.excerpt ||
                              result.headings.slice(0, 2).join(" · ")}
                          </small>
                        </span>
                        <Icon name="chevron-right" size={15} />
                      </Link>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="search-empty">
                  <Icon name="search" size={22} />
                  <strong>No matching pages</strong>
                  <span>Try a toolkit, API method, or broader phrase.</span>
                </div>
              )}
            </div>
            <footer className="search-dialog__footer">
              <span>
                <kbd>↑</kbd>
                <kbd>↓</kbd> navigate
              </span>
              <span>
                <kbd>↵</kbd> open
              </span>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}
