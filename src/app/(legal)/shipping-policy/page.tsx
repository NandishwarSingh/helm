import { type Metadata } from "next";
import Link from "next/link";

import { siteConfig } from "@/config/site";

const { name, legal } = siteConfig;

export const metadata: Metadata = {
  title: "Shipping & Delivery Policy",
  description: `${name} is a digital service. Access is delivered electronically and instantly — there is no physical shipping.`,
  alternates: { canonical: "/shipping-policy" },
};

export default function ShippingPolicy() {
  return (
    <article className="legal-doc">
      <h1>Shipping &amp; Delivery Policy</h1>
      <p className="legal-meta">Last updated: {legal.effectiveDate}</p>

      <h2>Digital delivery</h2>
      <p>
        {name} is a software-as-a-service product. It is delivered entirely
        online, so <strong>no physical goods are shipped</strong> and no shipping
        charges apply.
      </p>

      <h2>Access to paid features</h2>
      <p>
        When you purchase a subscription, access to the corresponding features is
        activated on your account <strong>immediately</strong> after your payment
        is confirmed by our payment partner, Razorpay. You can start using the
        Service right away by signing in at{" "}
        <Link href="/">{siteConfig.url.replace(/^https?:\/\//, "")}</Link>.
      </p>

      <h2>If access isn&rsquo;t activated</h2>
      <p>
        In the rare case that a successful payment does not unlock your features
        within a few minutes, contact us at{" "}
        <a href={`mailto:${legal.email}`}>{legal.email}</a> with your
        order/transaction reference and we will resolve it promptly.
      </p>

      <h2>Service availability</h2>
      <p>
        We aim to keep the Service available at all times, but it may be
        temporarily unavailable for maintenance or for reasons beyond our
        control. This does not affect the digital nature of delivery described
        above.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about delivery or access? Email{" "}
        <a href={`mailto:${legal.email}`}>{legal.email}</a> or see our{" "}
        <Link href="/contact">Contact page</Link>.
      </p>
    </article>
  );
}
