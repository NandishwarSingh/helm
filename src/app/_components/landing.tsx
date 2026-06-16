"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";

import { BrandMark } from "@/components/brand-mark";
import {
  ArchiveIcon,
  CalendarIcon,
  ComposeIcon,
  MailIcon,
  ReplyIcon,
  StarIcon,
} from "@/components/icons";
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
  initial: { opacity: 0, y: 10 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: "-60px" },
  transition: { duration: 0.4, ease: [0.2, 0, 0, 1] as const },
};

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
          <BrandMark size={14} />
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
              <span
                className="lp-mock-snippet"
                style={{ width: `${row.w}%` }}
              />
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

export function Landing() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("error");
    if (code) setError(ERRORS[code] ?? "Something went wrong. Please try again.");
  }, []);

  return (
    <div className="lp">
      <header className="lp-bar">
        <span className="lp-brand">
          <BrandMark size={18} />
          {siteConfig.name}
        </span>
        <span className="topbar-spacer" />
        <a className="btn" href="#how-it-works">
          How it works
        </a>
        <a className="btn btn-primary" href="/api/oauth/start">
          Connect Google
        </a>
      </header>

      <main>
        <section className="lp-hero">
          <motion.div
            className="lp-hero-copy"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: [0.2, 0, 0, 1] }}
          >
            <h1>Your inbox, at the speed of your keyboard.</h1>
            <p className="lp-sub">
              {siteConfig.name} is a command center for Gmail and Google
              Calendar. Triage, reply, search and schedule in single
              keystrokes — without ever reaching for the mouse.
            </p>
            <div className="lp-cta-row">
              <a className="btn btn-primary lp-cta" href="/api/oauth/start">
                Connect Google
              </a>
              <a className="btn lp-cta" href="#features">
                See what it does
              </a>
            </div>
            {error && <p className="error lp-error">{error}</p>}
            <p className="lp-fine">
              Free during beta. Gmail and Calendar connect securely through
              Corsair — your Google password is never shared with{" "}
              {siteConfig.name}.
            </p>
          </motion.div>
          <motion.div
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.08, ease: [0.2, 0, 0, 1] }}
          >
            <HeroMock />
          </motion.div>
        </section>

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
            <Kbd>⌘</Kbd> <Kbd>K</Kbd> everything else
          </span>
          <span>
            <Kbd>⌘</Kbd> <Kbd>↵</Kbd> send
          </span>
        </motion.section>

        <section className="lp-section" id="features">
          <motion.h2 {...rise}>Built for the way work actually moves</motion.h2>
          <div className="lp-cards">
            <motion.article className="lp-card" {...rise}>
              <MailIcon size={18} />
              <h3>Keyboard triage</h3>
              <p>
                Move through your inbox with J and K, reply with R, archive
                with E. Folders, starring, bulk select and spam handling —
                your whole morning without a single click.
              </p>
            </motion.article>
            <motion.article
              className="lp-card"
              {...rise}
              transition={{ ...rise.transition, delay: 0.06 }}
            >
              <ComposeIcon size={18} />
              <h3>One palette for everything</h3>
              <p>
                Command-K turns every action into a search: compose, schedule,
                switch views, change theme, sign out. If you can type it, you
                can do it.
              </p>
            </motion.article>
            <motion.article
              className="lp-card"
              {...rise}
              transition={{ ...rise.transition, delay: 0.12 }}
            >
              <CalendarIcon size={18} />
              <h3>Calendar without the tab-switch</h3>
              <p>
                A week that lives next to your mail. Create events, send real
                invites, and turn any email into a meeting with one key.
              </p>
            </motion.article>
          </div>
        </section>

        <section className="lp-section">
          <motion.div className="lp-receipt" {...rise}>
            <div className="lp-receipt-col">
              <span className="lp-receipt-label tnum">GMAIL</span>
              <span className="lp-receipt-num tnum">6 clicks</span>
              <span className="lp-receipt-sub">to reply to one email</span>
            </div>
            <div className="lp-receipt-col" data-accent="true">
              <span className="lp-receipt-label tnum">{siteConfig.name.toUpperCase()}</span>
              <span className="lp-receipt-num tnum">0 clicks</span>
              <span className="lp-receipt-sub">R, type, ⌘↵ — sent</span>
            </div>
          </motion.div>
        </section>

        <section className="lp-section" id="how-it-works">
          <motion.h2 {...rise}>Your account stays yours</motion.h2>
          <div className="lp-trust">
            <motion.div className="lp-trust-row" {...rise}>
              <span className="lp-trust-label tnum">YOUR ACCOUNT</span>
              <p>
                Connects through Google OAuth. {siteConfig.name} never sees
                your password, and you can revoke access from your Google
                account at any time.
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

        <section className="lp-section">
          <motion.h2 {...rise}>Questions, answered</motion.h2>
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
                {siteConfig.name} is in beta and Google&apos;s verification is in
                progress. Choose Advanced, then Continue — the permissions
                requested are only Gmail and Calendar.
              </p>
            </details>
          </motion.div>
        </section>

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
        <span className="topbar-spacer" />
        <span className="lp-foot-note tnum">
          Built with Next.js, Postgres and Corsair
        </span>
      </footer>
    </div>
  );
}
