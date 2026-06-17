/**
 * Subtle background motif: faint Helm compass marks scattered across the page,
 * each drifting and breathing very gently. A quiet brand watermark — no canvas,
 * no rAF, no cursor tracking. Themes off --color-ink at ~5% opacity.
 */
const MARKS = [
  { t: 13, l: 9, s: 68, dur: 13, d: 0 },
  { t: 7, l: 43, s: 38, dur: 16, d: 4 },
  { t: 21, l: 73, s: 54, dur: 14, d: 2 },
  { t: 11, l: 92, s: 36, dur: 17, d: 6 },
  { t: 39, l: 21, s: 48, dur: 15, d: 5 },
  { t: 47, l: 57, s: 62, dur: 18, d: 1 },
  { t: 33, l: 88, s: 44, dur: 14, d: 7 },
  { t: 62, l: 12, s: 56, dur: 16, d: 3 },
  { t: 71, l: 46, s: 40, dur: 13, d: 8 },
  { t: 57, l: 81, s: 52, dur: 17, d: 5 },
  { t: 86, l: 27, s: 46, dur: 15, d: 2 },
  { t: 90, l: 66, s: 58, dur: 18, d: 6 },
  { t: 79, l: 93, s: 34, dur: 14, d: 4 },
  { t: 4, l: 61, s: 32, dur: 16, d: 9 },
];

export function LpMotifs() {
  return (
    <div className="lp-motifs" aria-hidden="true">
      {MARKS.map((m, i) => (
        <span
          key={i}
          className="lp-motif"
          style={{
            top: `${m.t}%`,
            left: `${m.l}%`,
            width: m.s,
            height: m.s,
            animationDuration: `${m.dur}s`,
            animationDelay: `${m.d}s`,
          }}
        >
          <svg viewBox="0 0 24 24" fill="none">
            <g
              stroke="currentColor"
              strokeWidth={1}
              strokeLinecap="round"
              fill="none"
            >
              <rect x="2.5" y="2.5" width="19" height="19" rx="3" />
              <path d="M12 6.4v11.2M6.4 12h11.2M8.3 8.3l7.4 7.4M15.7 8.3l-7.4 7.4" />
              <circle cx="12" cy="12" r="2.2" />
            </g>
          </svg>
        </span>
      ))}
    </div>
  );
}
