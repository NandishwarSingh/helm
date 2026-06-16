"use client";

import { useEffect, useRef, useState } from "react";
import {
  motion,
  useInView,
  useSpring,
  useTransform,
} from "motion/react";

import { BrandMark } from "@/components/brand-mark";
import { ArchiveIcon, ReplyIcon, StarIcon } from "@/components/icons";
import { Kbd } from "@/components/kbd";
import { siteConfig } from "@/config/site";

const ERRORS: Record<string, string> = {
  denied: "Access was declined. Connect again when you're ready.",
  missing_code: "Sign-in didn't complete. Please try again.",
  bad_state: "Your sign-in link expired. Please try again.",
  oauth_callback: "Couldn't finish connecting. Please try again.",
  rate_limited: "Too many attempts. Please wait a moment and try again.",
};

const rise = {
  initial: { opacity: 0, y: 12 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: "-70px" },
  transition: { duration: 0.45, ease: [0.2, 0, 0, 1] as const },
};

/* ---- animated stat counter (FieldMind-style, brand spring) ------------- */
function AnimatedNumber({
  value,
  prefix = "",
  suffix = "",
}: {
  value: number;
  prefix?: string;
  suffix?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "-40px" });
  const spring = useSpring(0, { mass: 1, stiffness: 90, damping: 26 });
  const display = useTransform(spring, (current) =>
    Math.round(current).toLocaleString("en-US"),
  );

  useEffect(() => {
    if (inView) spring.set(value);
  }, [inView, value, spring]);

  return (
    <span ref={ref}>
      {prefix}
      <motion.span>{display}</motion.span>
      {suffix}
    </span>
  );
}

/* ---- hero product mock -------------------------------------------------- */
const MOCK_ROWS = [
  { from: "Priya Nair", subject: "Q3 roadmap review", w: 72 },
  { from: "Github", subject: "PR #214 approved and merged", w: 58 },
  { from: "Dev Jain", subject: "Re: Corsair webhook setup", w: 81 },
  { from: "Linear", subject: "Cycle 12 starts Monday", w: 64 },
  { from: "Ana Souza", subject: "Design tokens handoff", w: 69 },
];

function HeroMock() {
  return (
    <div className="lp-mock" aria-hidden="true">
      <div className="lp-mock-rail">
        <span className="lp-mock-brand">
          <BrandMark size={15} />
        </span>
        <span className="lp-mock-railitem" data-on="true" />
        <span className="lp-mock-railitem" />
        <span className="lp-mock-divider" />
        <span className="lp-mock-railitem sub" />
        <span className="lp-mock-railitem sub" />
        <span className="lp-mock-railitem sub" />
      </div>
      <div className="lp-mock-list">
        <div className="lp-mock-search" />
        <div className="lp-mock-rows">
          <span className="lp-mock-cursor" />
          {MOCK_ROWS.map((row) => (
            <div className="lp-mock-row" key={row.subject}>
              <span className="lp-mock-from">{row.from}</span>
              <span className="lp-mock-subject">{row.subject}</span>
              <span className="lp-mock-snippet" style={{ width: `${row.w}%` }} />
            </div>
          ))}
        </div>
      </div>
      <div className="lp-mock-read">
        <div className="lp-mock-actions">
          <ArchiveIcon size={13} />
          <StarIcon size={13} />
          <ReplyIcon size={13} />
        </div>
        <div className="lp-mock-subjectline" />
        <div className="lp-mock-meta" />
        <div className="lp-mock-body">
          <span style={{ width: "94%" }} />
          <span style={{ width: "88%" }} />
          <span style={{ width: "97%" }} />
          <span style={{ width: "72%" }} />
          <span style={{ width: "84%" }} />
          <span style={{ width: "46%" }} />
        </div>
      </div>
    </div>
  );
}

/* ---- section header rhythm ---------------------------------------------- */
function SectionHead({
  label,
  title,
  desc,
}: {
  label: string;
  title: string;
  desc?: string;
}) {
  return (
    <motion.div className="lp-head" {...rise}>
      <p className="lp-label tnum">{label}</p>
      <h2 className="lp-title">{title}</h2>
      {desc && <p className="lp-desc">{desc}</p>}
    </motion.div>
  );
}

export function Landing() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("error");
    if (code) setError(ERRORS[code] ?? "Something went wrong. Please try again.");
  }, []);

  return (
    <div className="lp">
      <nav className="lp-nav">
        <span className="lp-brand">
          <BrandMark size={18} />
          {siteConfig.name}
        </span>
        <div className="lp-nav-links">
          <a href="#how-it-works">How it works</a>
          <a href="#compare">Compare</a>
          <a href="#faq">FAQ</a>
        </div>
        <span className="topbar-spacer" />
        <a className="btn btn-primary" href="/api/oauth/start">
          Connect Google
        </a>
      </nav>

      <main>
        {/* ---- hero ---- */}
        <section className="lp-hero">
          <motion.p
            className="lp-eyebrow tnum"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.2, 0, 0, 1] }}
          >
            KEYBOARD-FIRST COMMAND CENTER FOR GMAIL + CALENDAR
          </motion.p>
          <motion.h1
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.05, ease: [0.2, 0, 0, 1] }}
          >
            Your inbox, at the speed
            <br />
            of your <em>keyboard</em>.
          </motion.h1>
          <motion.p
            className="lp-sub"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.12, ease: [0.2, 0, 0, 1] }}
          >
            {siteConfig.name} puts Gmail and Google Calendar in one fast
            window where every action — triage, reply, search, schedule — is
            a single keystroke. Stop clicking through your day.
          </motion.p>
          <motion.div
            className="lp-cta-row"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, delay: 0.18, ease: [0.2, 0, 0, 1] }}
          >
            <a className="btn btn-primary lp-cta" href="/api/oauth/start">
              Connect Google
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M3 8h10m0 0L9 4m4 4L9 12"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </a>
            <a className="btn lp-cta" href="#how-it-works">
              See how it works
            </a>
          </motion.div>
          {error && <p className="error lp-error">{error}</p>}
          <motion.p
            className="lp-fine"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.3 }}
          >
            Free during beta. Connects securely through Corsair — your Google
            password is never shared with {siteConfig.name}.
          </motion.p>

          <motion.div
            className="lp-stats"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.24, ease: [0.2, 0, 0, 1] }}
          >
            <div className="lp-stat">
              <span className="lp-stat-num tnum">
                <AnimatedNumber value={0} />
              </span>
              <span className="lp-stat-label">clicks to clear an inbox</span>
            </div>
            <div className="lp-stat">
              <span className="lp-stat-num tnum">
                <AnimatedNumber value={30} suffix="+" />
              </span>
              <span className="lp-stat-label">keyboard shortcuts</span>
            </div>
            <div className="lp-stat">
              <span className="lp-stat-num tnum">
                <AnimatedNumber value={2} />
              </span>
              <span className="lp-stat-label">Google apps, one window</span>
            </div>
            <div className="lp-stat">
              <span className="lp-stat-num tnum">
                <AnimatedNumber value={1} prefix="under " suffix="s" />
              </span>
              <span className="lp-stat-label">cached lists and search</span>
            </div>
          </motion.div>

          <motion.div
            className="lp-mock-wrap"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.3, ease: [0.2, 0, 0, 1] }}
          >
            <HeroMock />
          </motion.div>
        </section>

        {/* ---- proof strip ---- */}
        <motion.section className="lp-strip" {...rise}>
          <span>
            <Kbd>J</Kbd> <Kbd>K</Kbd> fly through mail
          </span>
          <span>
            <Kbd>R</Kbd> reply
          </span>
          <span>
            <Kbd>E</Kbd> archive
          </span>
          <span>
            <Kbd>G</Kbd> jump anywhere
          </span>
          <span>
            <Kbd>⌘</Kbd> <Kbd>K</Kbd> everything else
          </span>
          <span>
            <Kbd>⌘</Kbd> <Kbd>↵</Kbd> send
          </span>
        </motion.section>

        {/* ---- how it works ---- */}
        <section className="lp-section" id="how-it-works">
          <SectionHead
            label="HOW IT WORKS"
            title="Connected in one consent, fast forever after"
          />
          <div className="lp-steps">
            <motion.div className="lp-step" {...rise}>
              <span className="lp-step-num tnum">01</span>
              <h3>Connect Google</h3>
              <p>
                One OAuth consent covers Gmail and Calendar together. Revoke it
                from your Google account at any time.
              </p>
            </motion.div>
            <motion.div className="lp-step" {...rise} transition={{ ...rise.transition, delay: 0.07 }}>
              <span className="lp-step-num tnum">02</span>
              <h3>Corsair syncs and encrypts</h3>
              <p>
                Your mailbox mirrors into an envelope-encrypted Postgres cache,
                isolated per user, kept fresh as you work.
              </p>
            </motion.div>
            <motion.div className="lp-step" {...rise} transition={{ ...rise.transition, delay: 0.14 }}>
              <span className="lp-step-num tnum">03</span>
              <h3>Fly</h3>
              <p>
                Lists and search answer from the cache in under a second; sends
                and invites hit Google live. J, K, done.
              </p>
            </motion.div>
          </div>
        </section>

        {/* ---- comparison ---- */}
        <section className="lp-section" id="compare">
          <SectionHead
            label="COMPARE"
            title="The speed of Superhuman, the price of neither"
          />
          <motion.div className="lp-compare-wrap" {...rise}>
            <table className="lp-compare">
              <thead>
                <tr>
                  <th>Capability</th>
                  <th data-accent="true">{siteConfig.name}</th>
                  <th>Gmail</th>
                  <th>Superhuman</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Keyboard-first triage</td>
                  <td data-accent="true">Yes</td>
                  <td>Partial</td>
                  <td>Yes</td>
                </tr>
                <tr>
                  <td>Mail and calendar in one window</td>
                  <td data-accent="true">Yes</td>
                  <td className="lp-no">—</td>
                  <td>Partial</td>
                </tr>
                <tr>
                  <td>Email to calendar event in one key</td>
                  <td data-accent="true">Yes</td>
                  <td className="lp-no">—</td>
                  <td>Yes</td>
                </tr>
                <tr>
                  <td>Sub-second cached search</td>
                  <td data-accent="true">Yes</td>
                  <td className="lp-no">—</td>
                  <td>Yes</td>
                </tr>
                <tr>
                  <td>Open source, inspectable</td>
                  <td data-accent="true">Yes</td>
                  <td className="lp-no">—</td>
                  <td className="lp-no">—</td>
                </tr>
                <tr>
                  <td>Price</td>
                  <td data-accent="true">Free beta</td>
                  <td>Free</td>
                  <td>$25+/mo</td>
                </tr>
              </tbody>
            </table>
          </motion.div>
        </section>

        {/* ---- pricing ---- */}
        <section className="lp-section" id="pricing">
          <SectionHead label="PRICING" title="Simple while we build" />
          <motion.div className="lp-price" {...rise}>
            <p className="lp-price-tier tnum">BETA</p>
            <p className="lp-price-amount">Free</p>
            <p className="lp-price-desc">
              Everything, for every connected account, while {siteConfig.name}
              {" "}is in beta.
            </p>
            <ul className="lp-price-list">
              <li>Full Gmail workflow — folders, bulk triage, drafts, spam</li>
              <li>Calendar with real invites, edits and cancellations</li>
              <li>Command palette and the complete keyboard map</li>
              <li>Encrypted per-user cache, revoke any time</li>
            </ul>
            <a className="btn btn-primary lp-cta" href="/api/oauth/start">
              Connect Google
            </a>
          </motion.div>
        </section>

        {/* ---- trust ---- */}
        <section className="lp-section" id="trust">
          <SectionHead label="YOUR DATA" title="Your account stays yours" />
          <div className="lp-trust">
            <motion.div className="lp-trust-row" {...rise}>
              <span className="lp-trust-label tnum">YOUR ACCOUNT</span>
              <p>
                Connects through Google OAuth. {siteConfig.name} never sees your
                password, and you can revoke access from your Google account at
                any time.
              </p>
            </motion.div>
            <motion.div className="lp-trust-row" {...rise}>
              <span className="lp-trust-label tnum">YOUR DATA</span>
              <p>
                Messages are mirrored into an encrypted store so search and
                browsing feel instant. Never sold, never used for training.
              </p>
            </motion.div>
            <motion.div className="lp-trust-row" {...rise}>
              <span className="lp-trust-label tnum">YOUR KEYS</span>
              <p>
                Every token is envelope-encrypted with a key that stays on the
                server — handled by Corsair and Postgres, isolated per user.
              </p>
            </motion.div>
          </div>
        </section>

        {/* ---- FAQ ---- */}
        <section className="lp-section" id="faq">
          <SectionHead label="FAQ" title="Questions, answered" />
          <motion.div className="lp-faq" {...rise}>
            <details>
              <summary>Is my email stored?</summary>
              <p>
                Headers and snippets are cached in an encrypted database so
                lists and search are instant. Full messages are fetched live
                from Gmail when you open them. Disconnecting your account
                removes the cache.
              </p>
            </details>
            <details>
              <summary>What does {siteConfig.name} cost?</summary>
              <p>
                Nothing during the beta. If that changes, connected users hear
                about it first — there are no surprise charges.
              </p>
            </details>
            <details>
              <summary>Does it work with Google Workspace accounts?</summary>
              <p>
                Yes — any Google account works. Some Workspace organisations
                require an admin to allow third-party access first.
              </p>
            </details>
            <details>
              <summary>Why does Google show an unverified-app screen?</summary>
              <p>
                {siteConfig.name} is in beta and Google&apos;s verification is
                in progress. Choose Advanced, then Continue — the permissions
                requested are only Gmail and Calendar.
              </p>
            </details>
          </motion.div>
        </section>

        {/* ---- final CTA ---- */}
        <section className="lp-final">
          <motion.div {...rise}>
            <BrandMark size={28} />
            <h2>Take the helm of your inbox.</h2>
            <a className="btn btn-primary lp-cta" href="/api/oauth/start">
              Connect Google
            </a>
          </motion.div>
        </section>
      </main>

      <footer className="lp-foot">
        <span className="lp-brand">
          <BrandMark size={15} />
          {siteConfig.name}
        </span>
        <div className="lp-foot-links">
          <a href="#compare">Compare</a>
          <a href="#faq">FAQ</a>
        </div>
        <span className="topbar-spacer" />
        <span className="lp-foot-note tnum">
          Built with Next.js, Postgres and Corsair
        </span>
      </footer>
    </div>
  );
}
