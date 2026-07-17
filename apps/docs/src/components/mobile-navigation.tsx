"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { ApertureLogo } from "./aperture-logo";
import { Icon } from "./icon";

export function MobileNavigation({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest("a")) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    panelRef.current?.addEventListener("click", onClick);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
      panelRef.current?.removeEventListener("click", onClick);
    };
  }, [open]);

  return (
    <>
      <button
        aria-expanded={open}
        aria-label="Open documentation navigation"
        className="icon-button mobile-menu-button"
        onClick={() => setOpen(true)}
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
            type="button"
          />
          <aside
            aria-label="Documentation navigation"
            className="mobile-drawer__panel"
            ref={panelRef}
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
