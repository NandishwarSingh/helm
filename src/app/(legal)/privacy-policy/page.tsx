import { type Metadata } from "next";
import Link from "next/link";

import { siteConfig } from "@/config/site";

const { name, legal } = siteConfig;

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: `How ${name} collects, uses, protects and shares your information, including its limited use of Google account data.`,
  alternates: { canonical: "/privacy-policy" },
};

export default function PrivacyPolicy() {
  return (
    <article className="legal-doc">
      <h1>Privacy Policy</h1>
      <p className="legal-meta">Last updated: {legal.effectiveDate}</p>

      <p>
        This Privacy Policy explains how {legal.entity} (&ldquo;{name}
        &rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;) collects, uses, stores and
        shares information when you use {name} (the &ldquo;Service&rdquo;), a
        keyboard-first command center for Gmail and Google Calendar. By using
        the Service you agree to this Policy.
      </p>

      <h2>1. Information we collect</h2>
      <ul>
        <li>
          <strong>Account information.</strong> When you connect your Google
          account, we receive your email address and basic profile information
          through Google&rsquo;s OAuth consent screen.
        </li>
        <li>
          <strong>Your Gmail and Google Calendar data.</strong> To provide the
          Service, we access your messages, threads, labels, drafts and calendar
          events through Google&rsquo;s APIs. This data is used only to power the
          features you ask for (reading, searching, triaging, drafting, sending,
          and scheduling) and a cached copy may be stored to make the app fast.
        </li>
        <li>
          <strong>Payment information.</strong> Paid plans are processed by our
          payment partner, Razorpay. We do not store your full card or banking
          details; we receive only a transaction reference and status from
          Razorpay.
        </li>
        <li>
          <strong>Usage and technical data.</strong> Standard logs such as IP
          address, device/browser type and timestamps, used for security, abuse
          prevention and reliability.
        </li>
        <li>
          <strong>Cookies.</strong> A signed session cookie keeps you logged in.
          We do not use third-party advertising cookies.
        </li>
      </ul>

      <h2>2. How we use your information</h2>
      <ul>
        <li>To provide, maintain and improve the Service.</li>
        <li>
          To perform the actions you initiate on your Gmail and Calendar, and to
          power features such as AI-assisted triage and the agent.
        </li>
        <li>To process payments and manage your subscription.</li>
        <li>To secure the Service, prevent abuse and comply with the law.</li>
      </ul>
      <p>
        We do <strong>not</strong> sell your personal information, and we do{" "}
        <strong>not</strong> use your Gmail or Calendar content for advertising
        or to train generalized AI/ML models.
      </p>

      <h2>3. Google API Services — Limited Use</h2>
      <p>
        {name}&rsquo;s use and transfer of information received from Google APIs
        adheres to the{" "}
        <a
          href="https://developers.google.com/terms/api-services-user-data-policy"
          target="_blank"
          rel="noopener noreferrer"
        >
          Google API Services User Data Policy
        </a>
        , including its Limited Use requirements. We only request the scopes
        needed to run the features you use, we use Google user data solely to
        provide and improve those user-facing features, and we do not transfer
        or sell that data except as required to operate the Service or by law.
      </p>

      <h2>4. How we share information</h2>
      <p>We share information only with:</p>
      <ul>
        <li>
          <strong>Service providers</strong> that help us operate the Service —
          for example our integration layer (Corsair), AI model providers used
          to power assistant features, payment processing (Razorpay), bot
          protection (Cloudflare Turnstile) and hosting. They may process data
          only on our instructions.
        </li>
        <li>
          <strong>Legal and safety</strong> reasons — where required by law or
          to protect the rights, property or safety of users and the Service.
        </li>
      </ul>

      <h2>5. Data retention</h2>
      <p>
        We keep your information for as long as your account is active. When you
        disconnect an account or delete your {name} account, we revoke the
        relevant Google authorization and delete the associated cached mail,
        calendar and derived data, except where we must retain limited records
        to meet legal, tax or security obligations.
      </p>

      <h2>6. Security</h2>
      <p>
        We protect your data with industry-standard measures, including
        encryption in transit (HTTPS), signed sessions and access controls. No
        method of transmission or storage is perfectly secure, but we work to
        protect your information and limit access to it.
      </p>

      <h2>7. Your rights and choices</h2>
      <ul>
        <li>
          <strong>Disconnect at any time.</strong> You can remove any connected
          Google account from within {name}, which revokes our access and
          deletes its cached data. You can also revoke access from your{" "}
          <a
            href="https://myaccount.google.com/permissions"
            target="_blank"
            rel="noopener noreferrer"
          >
            Google Account permissions
          </a>
          .
        </li>
        <li>
          <strong>Access and deletion.</strong> You may request a copy of, or
          deletion of, the personal data we hold about you by contacting us.
        </li>
      </ul>

      <h2>8. Children</h2>
      <p>
        The Service is not directed to children under 13 (or the minimum age in
        your jurisdiction), and we do not knowingly collect their data.
      </p>

      <h2>9. Changes to this Policy</h2>
      <p>
        We may update this Policy from time to time. Material changes will be
        reflected by the &ldquo;Last updated&rdquo; date above and, where
        appropriate, communicated to you.
      </p>

      <h2>10. Contact us</h2>
      <p>
        Questions about this Policy? Email us at{" "}
        <a href={`mailto:${legal.email}`}>{legal.email}</a> or see our{" "}
        <Link href="/contact">Contact page</Link>.
      </p>
    </article>
  );
}
