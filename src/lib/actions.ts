"use client";

import { useEffect, useRef } from "react";

/**
 * Lightweight app-wide actions so the command palette and global shortcuts
 * can drive whichever panel is mounted, without prop-drilling.
 */
export type AppAction = "focus-search" | "refresh" | "toggle-theme";

const ACTION_EVENT = "helm:action";

export function dispatchAction(action: AppAction): void {
  window.dispatchEvent(new CustomEvent<AppAction>(ACTION_EVENT, { detail: action }));
}

export function useAction(action: AppAction, handler: () => void): void {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });
  useEffect(() => {
    function onAction(event: Event) {
      if ((event as CustomEvent<AppAction>).detail === action) {
        handlerRef.current();
      }
    }
    window.addEventListener(ACTION_EVENT, onAction);
    return () => window.removeEventListener(ACTION_EVENT, onAction);
  }, [action]);
}

/**
 * Overlay registry: while any overlay (palette, help, compose, dialog) is
 * open, background panels suspend their keyboard handlers. Each overlay's own
 * Escape handling still runs, so Esc always closes the topmost layer.
 */
let overlayCount = 0;

export function useOverlay(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    overlayCount += 1;
    return () => {
      overlayCount -= 1;
    };
  }, [open]);
}

export function hasOverlay(): boolean {
  return overlayCount > 0;
}

/** True when the event target is an editable control (typing context). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}
