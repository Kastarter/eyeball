"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type KeyboardEvent,
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
  const inputRef = useRef<HTMLInputElement>(null);
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

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((current) => !current);
      }
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  function close() {
    setOpen(false);
    setQuery("");
  }

  function handleListKeys(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => Math.min(current + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter") {
      const selected = results[activeIndex];
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
        className="search-trigger"
        onClick={() => setOpen(true)}
        type="button"
      >
        <Icon name="search" size={16} />
        <span>Search documentation</span>
        <kbd>⌘ K</kbd>
      </button>
      {open ? (
        <div className="search-dialog" role="presentation">
          <button
            aria-label="Close search"
            className="search-dialog__backdrop"
            onClick={close}
            type="button"
          />
          <section
            aria-label="Search documentation"
            aria-modal="true"
            className="search-dialog__surface"
            role="dialog"
          >
            <div className="search-dialog__input-wrap">
              <Icon name="search" size={18} />
              <input
                aria-activedescendant={
                  results[activeIndex]
                    ? `search-result-${activeIndex}`
                    : undefined
                }
                aria-controls="docs-search-results"
                aria-expanded="true"
                aria-label="Search documentation"
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveIndex(0);
                }}
                onKeyDown={handleListKeys}
                placeholder="Search guides, APIs, and toolkits…"
                ref={inputRef}
                role="combobox"
                value={query}
              />
              <button
                aria-label="Close search"
                className="search-close"
                onClick={close}
                type="button"
              >
                <span>esc</span>
              </button>
            </div>
            <div className="search-dialog__body">
              <p className="search-dialog__label">
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
                        aria-selected={activeIndex === index}
                        className={
                          activeIndex === index ? "is-active" : undefined
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
