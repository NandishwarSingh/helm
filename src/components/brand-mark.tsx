/**
 * Geometric helm/compass mark — a single SVG, no raster, no emoji.
 * Sized by the parent's font-size so it sits on the text baseline.
 */
export function BrandMark({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="2.5"
        y="2.5"
        width="19"
        height="19"
        rx="3"
        stroke="var(--color-accent)"
        strokeWidth="1.5"
      />
      <path
        d="M12 6.5v11M6.5 12h11M8.4 8.4l7.2 7.2M15.6 8.4l-7.2 7.2"
        stroke="var(--color-accent)"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <circle cx="12" cy="12" r="2.2" fill="var(--color-paper-sunken)" stroke="var(--color-accent)" strokeWidth="1.3" />
    </svg>
  );
}
