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

  const utils = api.useUtils();

  const enter = () => {
    if (entered.current) return;
    entered.current = true;
    onEnter();
  };

  const arm = () => setPhase((p) => (p === "syncing" ? "armed" : p));

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        el.setAttribute("reveal-threshold", "0.3");
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

  // Arm the cloth: unlock tearing and hand the cursor to the saw.
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
      {phase === "armed" && <SawCursor />}
    </div>
  );
}

/** A circular saw blade that follows the pointer and spins while cutting. */
const TEETH = 16;
const SAW_POINTS = Array.from({ length: TEETH * 2 }, (_, i) => {
  const r = i % 2 === 0 ? 17 : 13.4;
  const a = (Math.PI / TEETH) * i - Math.PI / 2;
  return `${(20 + r * Math.cos(a)).toFixed(2)},${(20 + r * Math.sin(a)).toFixed(2)}`;
}).join(" ");

function SawCursor() {
  const x = useMotionValue(-100);
  const y = useMotionValue(-100);
  const sx = useSpring(x, { stiffness: 900, damping: 60, mass: 0.4 });
  const sy = useSpring(y, { stiffness: 900, damping: 60, mass: 0.4 });
  const [cutting, setCutting] = useState(false);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      x.set(e.clientX);
      y.set(e.clientY);
    };
    const down = () => setCutting(true);
    const up = () => setCutting(false);
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
    <motion.div className="veil-saw" style={{ x: sx, y: sy }} aria-hidden="true">
      <motion.svg
        width="40"
        height="40"
        viewBox="0 0 40 40"
        fill="none"
        animate={{ rotate: 360, scale: cutting ? 1.12 : 1 }}
        transition={{
          rotate: {
            duration: cutting ? 0.5 : 1.4,
            repeat: Infinity,
            ease: "linear",
          },
          scale: snap,
        }}
        style={{ transformOrigin: "20px 20px" }}
      >
        <polygon
          points={SAW_POINTS}
          fill="#c9ced4"
          stroke="#6b7177"
          strokeWidth="1"
          strokeLinejoin="round"
        />
        <circle cx="20" cy="20" r="8.5" fill="#1a1814" stroke="#6b7177" strokeWidth="1" />
        <circle cx="20" cy="20" r="5.2" fill="none" stroke="var(--color-accent)" strokeWidth="1.4" />
        <circle cx="20" cy="20" r="1.7" fill="var(--color-accent)" />
      </motion.svg>
    </motion.div>
  );
}
