/** Minimal stroked glyphs — 1.5px, currentColor, no fills, no emoji. */
type IconProps = { size?: number };

function Svg({ size = 16, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const MailIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="m3.5 7 8.5 6 8.5-6" />
  </Svg>
);

export const CalendarIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="4.5" width="17" height="16" rx="2" />
    <path d="M3.5 9h17M8 3v3M16 3v3" />
  </Svg>
);

export const ComposeIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 20h16" />
    <path d="M14.5 5.5 18.5 9.5 9 19 5 19 5 15z" />
  </Svg>
);

export const CloseIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);

export const RefreshIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 11a8 8 0 1 0-2.3 5.7" />
    <path d="M20 4v5h-5" />
  </Svg>
);

export const SignOutIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-2" />
    <path d="M10 12h10m0 0-3-3m3 3-3 3" />
  </Svg>
);

export const ChevronLeftIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m14 6-6 6 6 6" />
  </Svg>
);

export const ChevronRightIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m10 6 6 6-6 6" />
  </Svg>
);

export const PlusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const MapPinIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11Z" />
    <circle cx="12" cy="10" r="2.5" />
  </Svg>
);

export const HelpIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.6 9.4a2.4 2.4 0 1 1 3.5 2.7c-.7.4-1.1.9-1.1 1.7v.4" />
    <path d="M12 17h.01" />
  </Svg>
);

export const ContrastIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 3v18M12 7a5 5 0 0 1 0 10" />
  </Svg>
);

export const ArchiveIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="5" rx="1.5" />
    <path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4" />
  </Svg>
);

export const TrashIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16M9 7V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v2" />
    <path d="M6.5 7l1 12a2 2 0 0 0 2 1.8h5a2 2 0 0 0 2-1.8l1-12M10 11v6M14 11v6" />
  </Svg>
);

export const StarIcon = ({
  size = 16,
  filled = false,
}: IconProps & { filled?: boolean }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={filled ? "currentColor" : "none"}
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="m12 3.5 2.7 5.5 6 .9-4.3 4.2 1 6-5.4-2.8-5.4 2.8 1-6L3.3 9.9l6-.9Z" />
  </svg>
);

export const ReplyIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.5 14.5 4 9.5 9.5 4.5" />
    <path d="M4 9.5h10a6 6 0 0 1 6 6v3" />
  </Svg>
);

export const ForwardIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14.5 14.5 20 9.5 14.5 4.5" />
    <path d="M20 9.5H10a6 6 0 0 0-6 6v3" />
  </Svg>
);

export const CalendarPlusIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="4.5" width="17" height="16" rx="2" />
    <path d="M3.5 9h17M8 3v3M16 3v3M12 12v5M9.5 14.5h5" />
  </Svg>
);

export const MailOpenIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m3 9 9-6 9 6v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    <path d="m3.4 9.6 8.6 5.9 8.6-5.9" />
  </Svg>
);
