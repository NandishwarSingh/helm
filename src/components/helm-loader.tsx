"use client";

import { motion } from "motion/react";

/**
 * Branded loading indicator: the Helm compass mark with an orbiting arc,
 * slowly rotating rays, and a pulsing core. Used for full-view loads where a
 * skeleton doesn't fit.
 */
export function HelmLoader({ size = 40 }: { size?: number }) {
  return (
    <span
      className="helm-loader"
      role="status"
      aria-label="Loading"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <motion.rect
          x="2.5"
          y="2.5"
          width="19"
          height="19"
          rx="4"
          stroke="var(--color-accent)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeDasharray="22 56"
          animate={{ strokeDashoffset: [0, -78] }}
          transition={{ duration: 1.5, repeat: Infinity, ease: "linear" }}
        />
        <motion.g
          stroke="var(--color-accent)"
          strokeWidth="1.3"
          strokeLinecap="round"
          style={{ transformOrigin: "12px 12px" }}
          animate={{ rotate: 360 }}
          transition={{ duration: 3.2, repeat: Infinity, ease: "linear" }}
        >
          <path d="M12 6.4v11.2M6.4 12h11.2M8.3 8.3l7.4 7.4M15.7 8.3l-7.4 7.4" />
        </motion.g>
        <motion.circle
          cx="12"
          cy="12"
          r="2.3"
          fill="var(--color-paper)"
          stroke="var(--color-accent)"
          strokeWidth="1.3"
          style={{ transformOrigin: "12px 12px" }}
          animate={{ scale: [1, 1.3, 1], opacity: [1, 0.65, 1] }}
          transition={{ duration: 1.3, repeat: Infinity, ease: "easeInOut" }}
        />
      </svg>
    </span>
  );
}
