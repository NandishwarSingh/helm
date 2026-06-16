"use client";

import { motion } from "motion/react";

import { MailRowsSkeleton } from "@/components/skeleton";

/**
 * Soft SVG morph mark. A filled path eases between a circle and a squircle on a
 * loop (a true `d`-attribute morph — both keyframes share the same M·4C·Z
 * structure) while the mark rotates and a centre dot breathes. Kept soft (no
 * sharp states) so it reads as a calm "working" pulse rather than a spinner.
 */
const CIRCLE =
  "M12 4C16.42 4 20 7.58 20 12C20 16.42 16.42 20 12 20C7.58 20 4 16.42 4 12C4 7.58 7.58 4 12 4Z";
const SQUIRCLE =
  "M12 4C17.5 4 20 6.5 20 12C20 17.5 17.5 20 12 20C6.5 20 4 17.5 4 12C4 6.5 6.5 4 12 4Z";

export function MorphLoader({ size = 20 }: { size?: number }) {
  return (
    <span
      className="morph-loader"
      role="status"
      aria-label="Loading"
      style={{ width: size, height: size }}
    >
      <motion.svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        style={{ transformOrigin: "12px 12px" }}
        animate={{ rotate: 360 }}
        transition={{ duration: 6, repeat: Infinity, ease: "linear" }}
      >
        <motion.path
          stroke="var(--color-accent)"
          strokeWidth={1.7}
          strokeLinejoin="round"
          fill="var(--color-accent-wash)"
          initial={{ d: CIRCLE }}
          animate={{ d: [CIRCLE, SQUIRCLE, CIRCLE] }}
          transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
        />
        <motion.circle
          cx="12"
          cy="12"
          r="2"
          fill="var(--color-accent)"
          style={{ transformOrigin: "12px 12px" }}
          animate={{ scale: [1, 0.5, 1], opacity: [1, 0.6, 1] }}
          transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
        />
      </motion.svg>
    </span>
  );
}

/**
 * Full-pane loading state: the morph mark + a status label over shimmering
 * skeleton rows that mirror the list layout — a calm "syncing" screen rather
 * than a bare spinner.
 */
export function SyncingState({
  label,
  count = 7,
}: {
  label: string;
  count?: number;
}) {
  return (
    <div className="syncing">
      <div className="syncing-head">
        <MorphLoader size={20} />
        <span className="syncing-text tnum" role="status">
          {label}
        </span>
      </div>
      <MailRowsSkeleton count={count} />
    </div>
  );
}
