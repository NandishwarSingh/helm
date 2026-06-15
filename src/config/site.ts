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
} as const;

export type SiteConfig = typeof siteConfig;
