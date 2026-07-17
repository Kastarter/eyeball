"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/src/lib/cn";
import { Icon } from "./icon";

export interface CopyButtonProps {
  className?: string;
  label?: string;
  value: string;
}

export function CopyButton({
  className,
  label = "Copy value",
  value,
}: CopyButtonProps) {
  const [state, setState] = useState<"copied" | "failed" | "idle">("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    },
    [],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
    if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setState("idle"), 1800);
  }

  const stateLabel =
    state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label;

  return (
    <button
      aria-label={`${label}: ${value}`}
      className={cn("copy-button", className)}
      onClick={copy}
      title={stateLabel}
      type="button"
    >
      <Icon name={state === "copied" ? "check" : "copy"} />
      <span aria-live="polite" className="visually-hidden">
        {state === "idle" ? "" : stateLabel}
      </span>
    </button>
  );
}
