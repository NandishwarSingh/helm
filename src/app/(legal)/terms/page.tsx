import { type Metadata } from "next";
import Link from "next/link";

import { siteConfig } from "@/config/site";

const { name, legal } = siteConfig;

export const metadata: Metadata = {
  title: "Terms & Conditions",
  description: `The terms that govern your use of ${name}, including accounts, acceptable use, subscriptions and payments.`,
  alternates: { canonical: "/terms" },
};

export default function Terms() {
  return (
    <article className="legal-doc">
      <h1>Terms &amp; Conditions</h1>
      <p className="legal-meta">Last updated: {legal.effectiveDate}</p>

      <p>
        These Terms &amp; Conditions (&ldquo;Terms&rdquo;) govern your access to
        and use of {name} (the &ldquo;Service&rdquo;), operated by{" "}
        {legal.entity}. By using the Service you agree to these Terms. If you do
        not agree, do not use the Service.
      </p>

      <h2>1. Eligibility</h2>
      <p>
        You must be at least 18 years old (or the age of majority in your
        jurisdiction) and able to enter into a binding contract to use the
        Service.
      </p>

      <h2>2. Your account and Google connection</h2>
      <p>
        {name} works by connecting to your Google (Gmail and Google Calendar)
        account with your permission. You are responsible for the activity on
        your account and for keeping your credentials secure. You may disconnect
        your Google account at any time, which revokes our access.
      </p>

      <h2>3. The Service</h2>
      <p>
        {name} helps you read, search, triage, draft, send and schedule mail and
        events more quickly. Features that send email, create or change calendar
        events, or delete data act on your real account; you are responsible for
        the actions you confirm. The Service is provided on an
        &ldquo;as-is&rdquo; and &ldquo;as-available&rdquo; basis and may change
        over time.
      </p>

      <h2>4. Acceptable use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>Use the Service for any unlawful, harmful or abusive purpose;</li>
        <li>Send spam or violate the terms of Google or any third party;</li>
        <li>
          Attempt to disrupt, reverse-engineer, scrape or gain unauthorized
          access to the Service or its systems;
        </li>
        <li>Use the Service to infringe the rights of others.</li>
      </ul>

      <h2>5. Subscriptions and payments</h2>
      <p>
        Some features require a paid subscription. Pricing and plan details are
        shown at the point of purchase. Payments are processed securely by our
        payment partner, Razorpay; by subscribing you also agree to Razorpay&rsquo;s
        applicable terms. Unless stated otherwise, subscriptions renew
        automatically until cancelled. Cancellations and refunds are governed by
        our <Link href="/refund-policy">Cancellation &amp; Refund Policy</Link>.
      </p>

      <h2>6. Intellectual property</h2>
      <p>
        The Service, including its software, design and content, is owned by{" "}
        {legal.entity} and protected by applicable laws. You retain all rights to
        your own data. We grant you a limited, non-exclusive, non-transferable
        right to use the Service in accordance with these Terms.
      </p>

      <h2>7. Third-party services</h2>
      <p>
        The Service relies on third parties such as Google, our integration
        layer and AI providers, and Razorpay. Your use of those services may be
        subject to their own terms, and we are not responsible for their acts or
        omissions.
      </p>

      <h2>8. Disclaimers</h2>
      <p>
        To the fullest extent permitted by law, the Service is provided without
        warranties of any kind, whether express or implied, including
        merchantability, fitness for a particular purpose and non-infringement.
        We do not warrant that the Service will be uninterrupted, error-free or
        secure.
      </p>

      <h2>9. Limitation of liability</h2>
      <p>
        To the fullest extent permitted by law, {legal.entity} will not be liable
        for any indirect, incidental, special, consequential or punitive damages,
        or any loss of data, revenue or profits, arising from your use of the
        Service. Our total liability for any claim relating to the Service will
        not exceed the amount you paid us for the Service in the three months
        before the claim.
      </p>

      <h2>10. Termination</h2>
      <p>
        You may stop using the Service and delete your account at any time. We
        may suspend or terminate access if you breach these Terms or to protect
        the Service or other users.
      </p>

      <h2>11. Governing law</h2>
      <p>
        These Terms are governed by the laws of {legal.jurisdiction}, and the
        courts located there will have exclusive jurisdiction, without regard to
        conflict-of-law principles.
      </p>

      <h2>12. Changes</h2>
      <p>
        We may update these Terms from time to time. The &ldquo;Last
        updated&rdquo; date above reflects the latest version; continued use of
        the Service after changes constitutes acceptance.
      </p>

      <h2>13. Contact</h2>
      <p>
        Questions about these Terms? Email{" "}
        <a href={`mailto:${legal.email}`}>{legal.email}</a> or see our{" "}
        <Link href="/contact">Contact page</Link>.
      </p>
    </article>
  );
}
