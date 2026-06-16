import type { Transition, Variants } from "motion/react";

/**
 * Motion language: short durations, decisive easing. The product should feel
 * snappy — nothing floats or lingers. Global reduced-motion is handled by
 * <MotionConfig reducedMotion="user"> in the app shell.
 */
export const easeSnap: Transition["ease"] = [0.2, 0, 0, 1];

export const snap: Transition = { duration: 0.18, ease: easeSnap };
export const snapFast: Transition = { duration: 0.12, ease: easeSnap };

export const viewSwap: Variants = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0, transition: snap },
  exit: { opacity: 0, y: -4, transition: snapFast },
};

export const listRow: Variants = {
  initial: { opacity: 0, x: -4 },
  animate: (i: number) => ({
    opacity: 1,
    x: 0,
    transition: { ...snapFast, delay: Math.min(i * 0.012, 0.16) },
  }),
};

// Centered modal: x/y carry the -50% centering offset (the element is pinned
// to the viewport centre via left/top: 50%), so motion owns the full transform.
export const slideOver: Variants = {
  initial: { opacity: 0, x: "-50%", y: "-46%", scale: 0.98 },
  animate: { opacity: 1, x: "-50%", y: "-50%", scale: 1, transition: snap },
  exit: { opacity: 0, x: "-50%", y: "-46%", scale: 0.98, transition: snapFast },
};

export const scrim: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: snapFast },
  exit: { opacity: 0, transition: snapFast },
};
