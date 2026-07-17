"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "./icon";

export interface CodeBlockProps {
  code: string;
  label?: string;
  language?: string;
}

export function CodeBlock({
  code,
  label = "SDK example",
  language = "typescript",
}: CodeBlockProps) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) {
        clearTimeout(resetTimer.current);
      }
    },
    [],
  );

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    if (resetTimer.current !== null) {
      clearTimeout(resetTimer.current);
    }
    resetTimer.current = setTimeout(() => setCopyState("idle"), 1800);
  }

  const copyLabel =
    copyState === "copied"
      ? "Copied"
      : copyState === "failed"
        ? "Copy failed"
        : "Copy";

  return (
    <figure aria-label={label} className="code-block">
      <figcaption className="code-block__header">
        <span className="code-block__language">{language}</span>
        <button
          aria-live="polite"
          className="code-block__copy"
          onClick={copyCode}
          type="button"
        >
          <span className="code-block__copy-inner">
            <Icon name={copyState === "copied" ? "check" : "copy"} />
            {copyLabel}
          </span>
        </button>
      </figcaption>
      <pre>
        <code>{code}</code>
      </pre>
    </figure>
  );
}
