"use client";

import { useEffect, useState } from "react";
import { Icon } from "./icon";

export function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return;
    }

    const timeout = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      aria-label={
        copied ? "Code copied" : "Copy the contents from the code block"
      }
      className="code-copy"
      onClick={copyCode}
      title={copied ? "Code copied" : "Copy code"}
      type="button"
    >
      <Icon name={copied ? "check" : "copy"} size={16} />
      <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}
