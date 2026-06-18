import { type Metadata } from "next";
import Link from "next/link";

import { siteConfig } from "@/config/site";

const { name, legal } = siteConfig;

export const metadata: Metadata = {
  title: "Contact Us",
  description: `Get in touch with the ${name} team — email, phone and business address.`,
  alternates: { canonical: "/contact" },
};

export default function Contact() {
  return (
    <article className="legal-doc">
      <h1>Contact Us</h1>
      <p className="legal-meta">Last updated: {legal.effectiveDate}</p>

      <p>
        We&rsquo;d love to hear from you. For support, billing or any question
        about {name}, reach us using the details below — we typically reply
        within 1&ndash;2 business days.
      </p>

      <dl className="legal-contact">
        <div>
          <dt>Business name</dt>
          <dd>{legal.entity}</dd>
        </div>
        <div>
          <dt>Email</dt>
          <dd>
            <a href={`mailto:${legal.email}`}>{legal.email}</a>
          </dd>
        </div>
        <div>
          <dt>Phone</dt>
          <dd>
            <a href={`tel:${legal.phone.replace(/\s+/g, "")}`}>{legal.phone}</a>
          </dd>
        </div>
        <div>
          <dt>Address</dt>
          <dd>{legal.address}</dd>
        </div>
      </dl>

      <h2>Support hours</h2>
      <p>Monday&ndash;Friday, 10:00&ndash;18:00 {legal.jurisdiction} time.</p>

      <h2>Policies</h2>
      <p>
        See our <Link href="/terms">Terms &amp; Conditions</Link>,{" "}
        <Link href="/privacy-policy">Privacy Policy</Link>,{" "}
        <Link href="/refund-policy">Cancellation &amp; Refund Policy</Link> and{" "}
        <Link href="/shipping-policy">Shipping &amp; Delivery Policy</Link>.
      </p>
    </article>
  );
}
