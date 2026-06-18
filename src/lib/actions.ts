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
 * Open-record bus: lets a deep component (e.g. an agent source citation) ask the
 * shell to navigate to and open a specific email or calendar event, without
 * prop-drilling through every panel. Carries the target as the event payload.
 */
export type OpenTarget = {
  kind: "email" | "event";
  accountId: string;
  id: string;
  /** Event start (ISO/date) so the calendar can jump to that week. */
  date?: string;
};

const OPEN_RECORD_EVENT = "helm:open-record";

export function dispatchOpenRecord(target: OpenTarget): void {
  window.dispatchEvent(
    new CustomEvent<OpenTarget>(OPEN_RECORD_EVENT, { detail: target }),
  );
}

export function useOpenRecord(handler: (target: OpenTarget) => void): void {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });
  useEffect(() => {
    function onOpen(event: Event) {
      handlerRef.current((event as CustomEvent<OpenTarget>).detail);
    }
    window.addEventListener(OPEN_RECORD_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_RECORD_EVENT, onOpen);
  }, []);
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
