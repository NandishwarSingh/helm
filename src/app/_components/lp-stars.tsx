import { type CSSProperties } from "react";

/**
 * Subtle constellation starfield for the landing background. Faint stars with a
 * slow, staggered twinkle, plus a few nautical navigation constellations (the
 * Plough, Cassiopeia's W, the Southern Cross) traced in thin sky lines. Pure SVG
 * + CSS animation — no canvas, no rAF, no cursor tracking.
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

// Nautical navigation constellations — vertices in the 100×60 viewBox, tucked
// toward the edges so the masked-out centre stays clean.
const CONSTELLATIONS: [number, number][][] = [
  // The Plough / Big Dipper — upper left
  [
    [7, 15],
    [13, 12],
    [19, 12.5],
    [25, 15],
    [26, 21],
    [20, 23],
    [14, 20.5],
  ],
  // Cassiopeia's W — upper right
  [
    [69, 10],
    [74, 14],
    [79, 10.5],
    [84, 15],
    [89, 11],
  ],
  // Southern Cross — lower right (two crossing strokes)
  [
    [81, 41],
    [81, 53],
  ],
  [
    [76, 47],
    [87, 46],
  ],
];

const VERTICES = CONSTELLATIONS.flat();

export function LpStars() {
  return (
    <div className="lp-stars" aria-hidden="true">
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="xMidYMid slice"
      >
        <g className="lp-star-lines">
          {CONSTELLATIONS.map((pts, i) => (
            <polyline key={i} points={pts.map((p) => p.join(",")).join(" ")} />
          ))}
        </g>
        {VERTICES.map((p, i) => (
          <circle
            key={`v${i}`}
            className="lp-star lp-star-key"
            cx={p[0]}
            cy={p[1]}
            r={0.26}
            style={{
              animationDuration: `${4 + (i % 4)}s`,
              animationDelay: `${(i % 5) * 0.7}s`,
            }}
          />
        ))}
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
