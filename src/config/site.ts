/**
 * Single source of truth for branding and SEO metadata.
 * Rename here once to rebrand the whole app (title, OG tags, sitemap, manifest).
 */
export const siteConfig = {
  name: "Helm",
  // Codename — swap for the final brand before launch.
  tagline: "A command center for Gmail and Google Calendar.",
  description:
    "Helm is a keyboard-first command center for Gmail and Google Calendar. Search, triage, schedule and reply in fewer keystrokes than the default UI.",
  url: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
  locale: "en_US",
  author: "Nandishwar Singh",
  twitter: "@NandishwarSingh",
  keywords: [
    "email client",
    "gmail workflow",
    "google calendar",
    "command palette email",
    "keyboard-first inbox",
    "superhuman alternative",
  ],
  // ─── Legal / business details ────────────────────────────────────────────
  // These render on every policy page (privacy, terms, refund, shipping,
  // contact) and are exactly what a payment gateway (Razorpay) verifies. FILL
  // THESE IN with real, working details before going live — a non-working
  // contact or placeholder address will fail Razorpay activation.
  legal: {
    entity: "Nandishwar Singh", // registered owner / legal name
    email: "nandubhai222@Gmail.com", // working support inbox
    phone: "+91 6005886885", // reachable phone number
    address: "Kathua, Jammu and Kashmir 184142, India", // registered address
    jurisdiction: "India", // governing law / courts
    effectiveDate: "June 16, 2026", // last-updated date shown on each policy
    // What the customer pays for + the refund window, in plain words.
    offering:
      "paid subscription plans that unlock Helm's full feature set (multi-account, the AI agent, and advanced search and triage)",
    refundWindowDays: 7,
  },
} as const;

export type SiteConfig = typeof siteConfig;
