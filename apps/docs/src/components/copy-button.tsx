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
    await navigator.clipboard.writeText(code);
    setCopied(true);
  }

  return (
    <button
      aria-label={copied ? "Code copied" : "Copy code"}
      className="code-copy"
      onClick={copyCode}
      type="button"
    >
      <Icon name={copied ? "check" : "copy"} size={14} />
      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}
