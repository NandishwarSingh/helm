"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useMotionValue, useSpring } from "motion/react";

import { HelmLoader } from "@/components/helm-loader";
import { api } from "@/trpc/react";
import { snap } from "@/lib/motion";

/**
 * First-connect takeover. While the very first Gmail sync runs the screen is
 * draped in a tearable physics cloth (the Veil engine) that cannot be torn —
 * a deliberate "please wait". When the sync lands, the cloth arms: the copy
 * flips to "Tear to enter", a saw follows the cursor, and ripping the cloth
 * away reveals the live app beneath it.
 *
 * Everything is progressive and fail-open: if the engine can't load, errors,
 * or the sync stalls, the overlay simply lets the user through.
 */

const VEIL_SCRIPT = "/veil/veil-cloth.js";
const VEIL_RUNTIME = "/veil/runtime/";
// Never trap the user behind a stalled sync.
const SYNC_FALLBACK_MS = 28_000;
// Let the cloth physically fall after the tear before the overlay clears.
const FALL_MS = 850;

type Phase = "syncing" | "armed" | "revealed";

// The custom element is loaded as a plain ES module script (it pulls its own
// WASM at runtime), so the bundler never touches it.
let scriptPromise: Promise<void> | null = null;
function loadVeilElement(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.customElements?.get("veil-cloth")) return Promise.resolve();
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.type = "module";
    script.src = VEIL_SCRIPT;
    script.onload = () =>
      window.customElements.whenDefined("veil-cloth").then(() => resolve());
    script.onerror = () => reject(new Error("veil engine failed to load"));
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export function FirstSyncVeil({ onEnter }: { onEnter: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const elRef = useRef<HTMLElement | null>(null);
  const [phase, setPhase] = useState<Phase>("syncing");
  const entered = useRef(false);
  const originalTitle = useRef("");

  const utils = api.useUtils();

  const enter = () => {
    if (entered.current) return;
    entered.current = true;
    // The veil engine renames the tab to "Veil"; put the app title back the
    // instant the user tears through (not only on the next refresh).
    if (originalTitle.current) document.title = originalTitle.current;
    onEnter();
  };

  const arm = () => setPhase((p) => (p === "syncing" ? "armed" : p));

  // Remember the real document title BEFORE the veil WASM overwrites it with
  // "Veil", and restore it whenever the overlay goes away (tear-through or
  // unmount) so the tab never stays stuck on "Veil".
  useEffect(() => {
    originalTitle.current = document.title;
    return () => {
      if (originalTitle.current) document.title = originalTitle.current;
    };
  }, []);

  // Drive the one first sync through the vanilla client (not useMutation):
  // its promise resolves independently of this component's lifecycle, so a
  // dev StrictMode remount can't orphan the result and leave us stuck. When
  // the sync settles, refresh the views, then arm the cloth. Fail-open on a
  // stall so the user is never trapped.
  // Fire the sync once (the ref survives a dev StrictMode double-invoke). No
  // cleanup-driven cancel flag here: the fake unmount must not abort the only
  // in-flight sync, and arm() is idempotent.
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    void utils.client.gmail.refreshInbox
      .mutate()
      .catch(() => undefined)
      .then(() =>
        Promise.allSettled([
          utils.gmail.searchEmails.invalidate(),
          utils.triage.overview.invalidate(),
        ]),
      )
      .finally(arm);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Separate, unguarded fail-open timer so the user is never trapped behind a
  // stalled sync — even if the chain above never resolves.
  useEffect(() => {
    const fallback = window.setTimeout(arm, SYNC_FALLBACK_MS);
    return () => window.clearTimeout(fallback);
  }, []);

  // Mount and configure the cloth element imperatively (React never owns the
  // nodes the engine relocates internally).
  useEffect(() => {
    let disposed = false;
    let el: HTMLElement | null = null;
    loadVeilElement()
      .then(() => {
        if (disposed || !hostRef.current) return;
        el = document.createElement("veil-cloth");
        el.className = "veil-host";
        el.setAttribute("src", VEIL_RUNTIME);
        // Dark fabric with a faint sky-slate crown — on theme with the app.
        el.setAttribute("color", "#212c36, #0d0c0a");
        // Edge-fraction torn before the cloth releases and falls. ~0.2 looks
        // like roughly half the cloth is gone (torn edges open big holes), so
        // it falls well before you have to shred the whole thing.
        el.setAttribute("reveal-threshold", "0.2");
        el.setAttribute("breeze", "10");
        // Locked until the sync completes.
        el.setAttribute("interaction", "none");
        el.setAttribute("tearable", "false");
        el.style.setProperty("--veil-cursor", "progress");
        el.addEventListener("veil-revealed", () => {
          setPhase("revealed");
          window.setTimeout(enter, FALL_MS);
        });
        el.addEventListener("veil-error", enter);
        hostRef.current.appendChild(el);
        elRef.current = el;
      })
      .catch(enter);
    return () => {
      disposed = true;
      const node: (HTMLElement & { destroy?: () => void }) | null = el;
      try {
        node?.destroy?.();
      } catch {
        /* already gone */
      }
      node?.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Arm the cloth: unlock tearing and hand the cursor to the grabbing hand.
  useEffect(() => {
    const el = elRef.current;
    if (!el || phase !== "armed") return;
    el.setAttribute("interaction", "both");
    el.setAttribute("tearable", "true");
    el.style.setProperty("--veil-cursor", "none");
  }, [phase]);

  return (
    <div
      ref={hostRef}
      className="veil-root"
      data-phase={phase}
      role="status"
      aria-live="polite"
    >
      <div className="veil-chrome">
        <AnimatePresence mode="wait">
          {phase === "syncing" ? (
            <motion.div
              key="syncing"
              className="veil-panel"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0, transition: snap }}
              exit={{ opacity: 0, y: -8, transition: { duration: 0.12 } }}
            >
              <HelmLoader size={46} />
              <h2 className="veil-title">
                Syncing Helm<span className="veil-beta">Beta</span>
              </h2>
              <p className="veil-sub">
                Setting up your inbox and calendar — this only happens once.
              </p>
            </motion.div>
          ) : phase === "armed" ? (
            <motion.div
              key="armed"
              className="veil-panel"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0, transition: snap }}
              exit={{ opacity: 0, transition: { duration: 0.2 } }}
            >
              <h2 className="veil-title veil-title-armed">Tear to enter</h2>
              <p className="veil-sub">Drag across the cloth to rip it away.</p>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
      {phase === "armed" && <HandCursor />}
    </div>
  );
}

/**
 * A hand that follows the pointer: open and ready to grab at rest, closing
 * into a grip while the cloth is being dragged/torn (pointer held down).
 */
function HandCursor() {
  const x = useMotionValue(-100);
  const y = useMotionValue(-100);
  const sx = useSpring(x, { stiffness: 900, damping: 60, mass: 0.4 });
  const sy = useSpring(y, { stiffness: 900, damping: 60, mass: 0.4 });
  const [grabbing, setGrabbing] = useState(false);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      x.set(e.clientX);
      y.set(e.clientY);
    };
    const down = () => setGrabbing(true);
    const up = () => setGrabbing(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up);
    };
  }, [x, y]);

  return (
    <motion.div
      className="veil-hand"
      style={{ x: sx, y: sy }}
      aria-hidden="true"
    >
      <motion.svg
        width="34"
        height="34"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--color-ink)"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        animate={{ scale: grabbing ? 0.82 : 1 }}
        transition={snap}
        style={{ transformOrigin: "12px 12px" }}
      >
        {/* Open hand, fingers extended — ready to grab. */}
        <motion.g
          animate={{ opacity: grabbing ? 0 : 1 }}
          transition={{ duration: 0.1 }}
        >
          <path d="M18 11V6a2 2 0 0 0-4 0" />
          <path d="M14 10V4a2 2 0 0 0-4 0v2" />
          <path d="M10 10.5V6a2 2 0 0 0-4 0v8" />
          <path d="M18 8a2 2 0 0 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
        </motion.g>
        {/* Closed grip — fingers curled while pulling the cloth. */}
        <motion.g
          animate={{ opacity: grabbing ? 1 : 0 }}
          transition={{ duration: 0.1 }}
        >
          <path d="M18 11.5V9a2 2 0 0 0-4 0v1.4" />
          <path d="M14 10V8a2 2 0 0 0-4 0v2" />
          <path d="M10 9.9V9a2 2 0 0 0-4 0v5" />
          <path d="M6 14a2 2 0 0 0-4 0a8 8 0 0 0 8 8h4a8 8 0 0 0 8-8v-1" />
        </motion.g>
      </motion.svg>
    </motion.div>
  );
}
