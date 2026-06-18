import Link from "next/link";

import { BrandMark } from "@/components/brand-mark";
import { siteConfig } from "@/config/site";

/** The policy pages, linked in the legal footer so each is one click + one crawl
 *  hop from any other (and from the landing footer). */
export const LEGAL_PAGES = [
  { href: "/privacy-policy", label: "Privacy Policy" },
  { href: "/terms", label: "Terms & Conditions" },
  { href: "/refund-policy", label: "Cancellation & Refund" },
  { href: "/shipping-policy", label: "Shipping & Delivery" },
  { href: "/contact", label: "Contact Us" },
] as const;

export default function LegalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="legal">
      <header className="legal-nav">
        <Link href="/" className="legal-brand" aria-label={siteConfig.name}>
          <BrandMark size={16} />
          {siteConfig.name}
        </Link>
        <Link href="/" className="legal-back">
          ← Back to {siteConfig.name}
        </Link>
      </header>

      <main className="legal-main">{children}</main>

      <footer className="legal-foot">
        <nav className="legal-foot-links" aria-label="Legal">
          {LEGAL_PAGES.map((p) => (
            <Link key={p.href} href={p.href}>
              {p.label}
            </Link>
          ))}
        </nav>
        <p className="legal-foot-note">
          © {new Date().getFullYear()} {siteConfig.legal.entity}. All rights
          reserved.
        </p>
      </footer>
    </div>
  );
}
