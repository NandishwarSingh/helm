/** Shimmering placeholder blocks shown while data loads. */
export function Skeleton({
  width,
  height = 12,
  className,
}: {
  width?: number | string;
  height?: number | string;
  className?: string;
}) {
  return (
    <span
      className={`skeleton${className ? ` ${className}` : ""}`}
      style={{
        width: typeof width === "number" ? `${width}px` : width,
        height: typeof height === "number" ? `${height}px` : height,
      }}
    />
  );
}

/** Placeholder rows that mirror the message list layout. */
export function MailRowsSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div className="row-skeleton" key={i}>
          <div className="row-skeleton-top">
            <Skeleton width={`${38 + ((i * 13) % 34)}%`} height={11} />
            <Skeleton width={42} height={10} />
          </div>
          <Skeleton width={`${55 + ((i * 17) % 30)}%`} height={11} />
          <Skeleton width={`${68 - ((i * 11) % 28)}%`} height={10} />
        </div>
      ))}
    </div>
  );
}

/** Placeholder for the open-message reading pane. */
export function ReadingSkeleton() {
  return (
    <div className="reading-skeleton" aria-hidden="true">
      <Skeleton width="62%" height={22} />
      <div className="reading-skeleton-meta">
        <Skeleton width={150} height={12} />
        <Skeleton width={90} height={12} />
      </div>
      <div className="reading-skeleton-body">
        {["92%", "98%", "85%", "70%", "94%", "60%"].map((w, i) => (
          <Skeleton key={i} width={w} height={12} />
        ))}
      </div>
    </div>
  );
}
