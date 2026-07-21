export const DIALOG_FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface FocusTarget {
  focus: () => void;
}

interface DialogTabEvent {
  key: string;
  preventDefault: () => void;
  shiftKey: boolean;
}

export function wrapDialogFocus(
  event: DialogTabEvent,
  focusable: readonly FocusTarget[],
  activeElement: unknown,
): boolean {
  if (event.key !== "Tab" || focusable.length === 0) return false;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && activeElement === first) {
    event.preventDefault();
    last?.focus();
    return true;
  }
  if (!event.shiftKey && activeElement === last) {
    event.preventDefault();
    first?.focus();
    return true;
  }
  return false;
}

export function focusFirstDialogControl(root: HTMLElement | null): void {
  root?.querySelector<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR)?.focus();
}
