import { type Metadata } from "next";
import Link from "next/link";

import { siteConfig } from "@/config/site";

const { name, legal } = siteConfig;

export const metadata: Metadata = {
  title: "Cancellation & Refund Policy",
  description: `How to cancel your ${name} subscription and when you are eligible for a refund.`,
  alternates: { canonical: "/refund-policy" },
};

export default function RefundPolicy() {
  return (
    <article className="legal-doc">
      <h1>Cancellation &amp; Refund Policy</h1>
      <p className="legal-meta">Last updated: {legal.effectiveDate}</p>

      <p>
        This policy explains how to cancel a {name} subscription and when
        refunds are available. {name} sells {legal.offering}.
      </p>

      <h2>1. Cancelling your subscription</h2>
      <p>
        You can cancel at any time from your account settings or by emailing us
        at <a href={`mailto:${legal.email}`}>{legal.email}</a>. When you cancel,
        your plan stays active until the end of the current billing period, and
        it will not renew after that. We do not charge a cancellation fee.
      </p>

      <h2>2. Refunds</h2>
      <p>
        If you are not satisfied with a paid plan, you may request a refund
        within <strong>{legal.refundWindowDays} days</strong> of your initial
        purchase. Approved refunds are issued to your original payment method
        through Razorpay.
      </p>
      <p>The following are generally not eligible for a refund:</p>
      <ul>
        <li>
          Renewal charges, where the renewal was not cancelled before the
          billing date;
        </li>
        <li>
          Requests made after the {legal.refundWindowDays}-day window above;
        </li>
        <li>Accounts suspended or terminated for breach of our Terms.</li>
      </ul>

      <h2>3. How to request a refund</h2>
      <p>
        Email <a href={`mailto:${legal.email}`}>{legal.email}</a> from the
        address associated with your account, with your order/transaction
        reference and the reason for the request. We aim to respond within 2&ndash;3
        business days.
      </p>

      <h2>4. Processing time</h2>
      <p>
        Once a refund is approved, it is initiated immediately on our side.
        Razorpay and your bank typically take 5&ndash;7 business days to credit
        the amount back to your original payment method.
      </p>

      <h2>5. Contact</h2>
      <p>
        For any billing question, reach us at{" "}
        <a href={`mailto:${legal.email}`}>{legal.email}</a> or via our{" "}
        <Link href="/contact">Contact page</Link>.
      </p>
    </article>
  );
}
