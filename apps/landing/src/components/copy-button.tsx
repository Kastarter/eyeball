"use client";

import { useState } from "react";
import { CopyIcon } from "./icons";

interface CopyButtonProps {
  code: string;
}

export function CopyButton({ code }: CopyButtonProps) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");

  async function copyCode(): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
  }

  const label = status === "copied" ? "Copied" : "Copy";

  return (
    <div className="copy-control">
      <button
        aria-label="Copy quickstart code"
        className="copy-button"
        onClick={copyCode}
        type="button"
      >
        <CopyIcon />
        <span>{label}</span>
      </button>
      <span aria-live="polite" className="visually-hidden" role="status">
        {status === "copied"
          ? "Quickstart code copied."
          : status === "failed"
            ? "Copy failed. Select the code and copy it manually."
            : ""}
      </span>
    </div>
  );
}
