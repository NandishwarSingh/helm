"use client";

import { motion } from "motion/react";

const RAYS = "M12 6.4v11.2M6.4 12h11.2M8.3 8.3l7.4 7.4M15.7 8.3l-7.4 7.4";

/**
 * The Helm compass, alive: eight rays that draw in and rotate slowly around a
 * breathing hub. No enclosing ring — just the mark.
 */
export function HelmGlyph({ size = 72 }: { size?: number }) {
  return (
    <span
      className="lp-glyph"
      aria-hidden="true"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <motion.g
          stroke="var(--color-accent)"
          strokeWidth={1.3}
          strokeLinecap="round"
          style={{ transformOrigin: "12px 12px" }}
          animate={{ rotate: 360 }}
          transition={{ duration: 26, repeat: Infinity, ease: "linear" }}
        >
          <motion.path
            d={RAYS}
            initial={{ pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 1 }}
            transition={{ duration: 1.3, delay: 0.2, ease: "easeOut" }}
          />
        </motion.g>
        <circle
          cx="12"
          cy="12"
          r="2.5"
          fill="var(--color-paper)"
          stroke="var(--color-accent)"
          strokeWidth={1.4}
        />
      </svg>
    </span>
  );
}
