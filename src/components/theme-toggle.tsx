"use client";

import { useEffect, useId, useState } from "react";
import { motion } from "motion/react";

import { useAction } from "@/lib/actions";

type Theme = "light" | "dark";

const RAYS = [
  [12, 1, 12, 3],
  [12, 21, 12, 23],
  [1, 12, 3, 12],
  [21, 12, 23, 12],
  [4.2, 4.2, 5.6, 5.6],
  [18.4, 18.4, 19.8, 19.8],
  [4.2, 19.8, 5.6, 18.4],
  [18.4, 5.6, 19.8, 4.2],
];

const spring = { type: "spring" as const, stiffness: 210, damping: 19 };

/**
 * Sun ⇄ moon theme switch. The crescent is carved with an SVG mask that
 * animates into place, so the morph is independent of the surface colour and
 * can't break against any background.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light");
  const maskId = useId();

  useEffect(() => {
    const current = document.documentElement.getAttribute("data-theme");
    setTheme(current === "dark" ? "dark" : "light");
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("helm-theme", next);
    } catch {
      // ignore storage failures (private mode)
    }
  }

  // Lets the command palette flip the theme.
  useAction("toggle-theme", toggle);

  const isDark = theme === "dark";

  return (
    <button
      type="button"
      className="icon-btn"
      onClick={toggle}
      data-tip={isDark ? "Switch to light theme" : "Switch to dark theme"}
      aria-label="Toggle colour theme"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
        <mask id={maskId}>
          <rect x="0" y="0" width="24" height="24" fill="white" />
          <motion.circle
            r="9"
            fill="black"
            initial={false}
            animate={{ cx: isDark ? 17 : 28, cy: isDark ? 7 : -4 }}
            transition={spring}
          />
        </mask>
        <motion.circle
          cx="12"
          cy="12"
          fill="currentColor"
          mask={`url(#${maskId})`}
          initial={false}
          animate={{ r: isDark ? 8 : 5 }}
          transition={spring}
        />
        <motion.g
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          initial={false}
          animate={{ opacity: isDark ? 0 : 1, scale: isDark ? 0.5 : 1 }}
          transition={spring}
          style={{ transformOrigin: "12px 12px" }}
        >
          {RAYS.map(([x1, y1, x2, y2], i) => (
            <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />
          ))}
        </motion.g>
      </svg>
    </button>
  );
}
