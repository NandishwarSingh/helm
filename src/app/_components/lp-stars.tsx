import { type CSSProperties } from "react";

/**
 * Subtle starfield for the landing background. Faint stars with a slow,
 * staggered twinkle. Pure SVG + CSS animation — no canvas, no rAF, no cursor
 * tracking.
 *
 * Star positions come from a seeded PRNG so the server and client render the
 * exact same markup (no hydration flicker). A radial mask fades the field out
 * behind the hero so it never competes with the headline.
 */

// mulberry32 — tiny deterministic PRNG so the field is stable across renders.
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VIEW_W = 100;
const VIEW_H = 60;

type Star = {
  x: number;
  y: number;
  r: number;
  tw: number;
  dur: number;
  delay: number;
  sky: boolean;
};

function buildStars(count: number): Star[] {
  const rand = rng(20240615);
  const stars: Star[] = [];
  for (let i = 0; i < count; i++) {
    stars.push({
      x: +(2 + rand() * (VIEW_W - 4)).toFixed(2),
      y: +(2 + rand() * (VIEW_H - 4)).toFixed(2),
      r: +(0.04 + rand() * 0.1).toFixed(3),
      tw: +(0.3 + rand() * 0.4).toFixed(2),
      dur: +(3 + rand() * 4).toFixed(1),
      delay: +(rand() * 6).toFixed(1),
      sky: rand() < 0.16,
    });
  }
  return stars;
}

const STARS = buildStars(54);

export function LpStars() {
  return (
    <div className="lp-stars" aria-hidden="true">
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="xMidYMid slice"
      >
        {STARS.map((s, i) => (
          <circle
            key={i}
            className="lp-star"
            cx={s.x}
            cy={s.y}
            r={s.r}
            fill={s.sky ? "#7dd3fc" : "#dfe7ef"}
            style={
              {
                "--tw": s.tw,
                animationDuration: `${s.dur}s`,
                animationDelay: `${s.delay}s`,
              } as CSSProperties
            }
          />
        ))}
      </svg>
    </div>
  );
}
