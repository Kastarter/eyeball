"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { ApertureLogo } from "./aperture-logo";
import { Icon } from "./icon";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  'summary:not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function MobileNavigation({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

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
      closeButtonRef.current?.focus(),
    );
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        return;
      }
      if (event.key !== "Tab") {
        return;
      }

      const focusable = Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ??
          [],
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [open]);

  return (
    <>
      <button
        aria-controls="docs-mobile-navigation"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Open documentation navigation"
        className="icon-button mobile-menu-button"
        onClick={() => setOpen(true)}
        ref={triggerRef}
        type="button"
      >
        <Icon name="menu" size={19} />
      </button>
      {open ? (
        <div className="mobile-drawer" role="presentation">
          <button
            aria-label="Close documentation navigation"
            className="mobile-drawer__backdrop"
            onClick={() => setOpen(false)}
            tabIndex={-1}
            type="button"
          />
          <aside
            aria-label="Documentation navigation"
            aria-modal="true"
            className="mobile-drawer__panel"
            id="docs-mobile-navigation"
            onClick={(event) => {
              const target = event.target;
              if (target instanceof Element && target.closest("a")) {
                setOpen(false);
              }
            }}
            onKeyDown={(event) => {
              const target = event.target;
              if (
                event.key === "Enter" &&
                target instanceof Element &&
                target.closest("a")
              ) {
                setOpen(false);
              }
            }}
            ref={panelRef}
            role="dialog"
          >
            <div className="mobile-drawer__header">
              <span className="brand">
                <ApertureLogo size={24} />
                <span className="brand__wordmark">eyeball</span>
                <span className="brand__product">docs</span>
              </span>
              <button
                aria-label="Close documentation navigation"
                className="icon-button"
                onClick={() => setOpen(false)}
                ref={closeButtonRef}
                type="button"
              >
                <Icon name="close" size={18} />
              </button>
            </div>
            <div className="mobile-drawer__scroll">{children}</div>
          </aside>
        </div>
      ) : null}
    </>
  );
}
