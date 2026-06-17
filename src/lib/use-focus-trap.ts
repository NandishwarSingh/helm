"use client";

import { useEffect } from "react";
import type { RefObject } from "react";

// Elements that can hold focus inside a dialog. Disabled controls and
// explicitly removed-from-tab-order nodes are skipped.
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE),
  ).filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/**
 * Keep keyboard focus inside an open dialog. On open the previously focused
 * element is recorded and focus moves into `ref` (unless it is already there,
 * so existing autoFocus wins); Tab / Shift+Tab cycle within `ref`; on close
 * focus returns to where it started. Escape handling stays with the caller —
 * this only governs Tab.
 */
export function useFocusTrap<T extends HTMLElement>(
  ref: RefObject<T | null>,
  isOpen: boolean,
): void {
  useEffect(() => {
    if (!isOpen) return;
    const container = ref.current;
    if (!container) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    // Pull focus into the dialog, but only after giving any caller-owned
    // autoFocus (cmdk's input, compose's deferred field focus) a beat to land —
    // then re-check, so we never yank focus off an element they chose.
    const focusTimer = window.setTimeout(() => {
      const el = ref.current;
      if (el && !el.contains(document.activeElement)) {
        focusable(el)[0]?.focus();
      }
    }, 80);

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Tab") return;
      const el = ref.current;
      if (!el) return;
      const items = focusable(el);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || !el.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !el.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKeyDown, true);
      previouslyFocused?.focus();
    };
  }, [ref, isOpen]);
}
