"use client";

import { useEffect, useRef, useState } from "react";
import {
  motion,
  useInView,
  useScroll,
  useSpring,
  useTransform,
} from "motion/react";
import Lenis from "lenis";

import { ConnectGoogle } from "@/app/_components/connect-google";
import { BrandMark } from "@/components/brand-mark";
import { HelmGlyph } from "@/components/helm-glyph";
import {
  AgentIcon,
  ArchiveIcon,
  CalendarIcon,
  ComposeIcon,
  ContrastIcon,
  MailIcon,
  ReplyIcon,
  SendIcon,
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
  verify: "Couldn't verify you're human. Please try again.",
};

/* ---------------------------------------------------------------- */

function useLenis() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const lenis = new Lenis({
      duration: 0.7,
      easing: (t) => 1 - Math.pow(1 - t, 3),
    });
    let raf = 0;
    const loop = (time: number) => {
      lenis.raf(time);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      lenis.destroy();
    };
  }, []);
}

function LandingThemeToggle() {
  const [dark, setDark] = useState(true);
  useEffect(() => {
    setDark(document.documentElement.getAttribute("data-theme") !== "light");
  }, []);
  return (
    <button
      type="button"
      className="lp-iconbtn"
      aria-label="Toggle colour theme"
      onClick={() => {
        const next = dark ? "light" : "dark";
        setDark(!dark);
        document.documentElement.setAttribute("data-theme", next);
        try {
          localStorage.setItem("helm-theme", next);
        } catch {
          // ignore (private mode)
        }
      }}
    >
      <ContrastIcon size={16} />
    </button>
  );
}

/* ---- product mocks ---- */

const INBOX = [
  { from: "Priya Nair", subject: "Q3 roadmap review", time: "9:24", unread: true, star: false },
  { from: "GitHub", subject: "PR #214 approved and merged", time: "9:02", unread: true, star: false },
  { from: "Dev Jain", subject: "Re: Corsair webhook setup", time: "8:41", unread: false, star: true },
  { from: "Linear", subject: "Cycle 12 starts Monday", time: "8:30", unread: false, star: false },
  { from: "Ana Souza", subject: "Design tokens handoff", time: "Tue", unread: false, star: false },
];

const COMMANDS = [
  { icon: <CalendarIcon size={15} />, label: "Go to Calendar", keys: ["G", "C"], key: "cal" },
  { icon: <ComposeIcon size={15} />, label: "Compose new message", keys: ["C"], key: "compose" },
  { icon: <AgentIcon size={15} />, label: "Ask the agent", keys: ["G", "A"], key: "agent" },
  { icon: <ArchiveIcon size={15} />, label: "Archive selected", keys: ["E"], key: "archive" },
];

function MailRow({
  m,
  active,
}: {
  m: (typeof INBOX)[number];
  active: boolean;
}) {
  return (
    <div className="lp-row" data-unread={m.unread} data-active={active}>
      <span className="lp-row-dot" />
      <span className="lp-row-main">
        <span className="lp-row-top">
          <span className="lp-row-from">{m.from}</span>
          <span className="lp-row-time tnum">{m.time}</span>
        </span>
        <span className="lp-row-sub">
          {m.star && <StarIcon size={12} filled />}
          {m.subject}
        </span>
      </span>
    </div>
  );
}

/** The hero centrepiece: an alive Helm window — the inbox with a moving J/K
 *  selection, and a ⌘K palette that types "cal" and surfaces Calendar. */
function HeroWindow() {
  const [sel, setSel] = useState(0);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    const selId = setInterval(() => setSel((s) => (s + 1) % INBOX.length), 1500);
    const word = "cal";
    let i = 0;
    let dir = 1;
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      setTyped(word.slice(0, i));
      if (dir > 0) {
        if (i < word.length) {
          i += 1;
          t = setTimeout(tick, 220);
        } else {
          dir = -1;
          t = setTimeout(tick, 2200);
        }
      } else if (i > 0) {
        i -= 1;
        t = setTimeout(tick, 110);
      } else {
        dir = 1;
        t = setTimeout(tick, 900);
      }
    };
    t = setTimeout(tick, 1100);
    return () => {
      clearInterval(selId);
      clearTimeout(t);
    };
  }, []);

  const typing = typed.length > 0;

  return (
    <div className="lp-win" aria-hidden="true">
      <div className="lp-win-bar">
        <span className="lp-win-brand">
          <BrandMark size={15} />
          {siteConfig.name}
        </span>
        <span className="lp-win-search">
          <span className="lp-win-search-ph">Search inbox</span>
          <Kbd>/</Kbd>
        </span>
        <span className="lp-win-cmd">
          Commands <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </span>
      </div>
      <div className="lp-win-body">
        <div className="lp-win-rail">
          <span className="lp-win-navitem" data-on="true">
            <MailIcon size={15} /> Mail
          </span>
          <span className="lp-win-navitem">
            <CalendarIcon size={15} /> Calendar
          </span>
          <span className="lp-win-navitem">
            <AgentIcon size={15} /> Agent
          </span>
          <span className="lp-win-raildiv" />
          <span className="lp-win-folder" data-on="true">
            Inbox<span className="tnum">5</span>
          </span>
          <span className="lp-win-folder">Priority</span>
          <span className="lp-win-folder">Starred</span>
          <span className="lp-win-folder">Sent</span>
        </div>
        <div className="lp-win-list">
          {INBOX.map((m, i) => (
            <MailRow key={m.subject} m={m} active={i === sel} />
          ))}
        </div>
      </div>
      <div className="lp-pal">
        <div className="lp-pal-input">
          {typed}
          <span className="lp-caret" />
          {!typing && <span className="lp-pal-ph">Type a command…</span>}
        </div>
        <div className="lp-pal-list">
          {COMMANDS.map((c, i) => (
            <span
              className="lp-pal-item"
              data-on={typing ? c.key === "cal" : i === 0}
              key={c.label}
            >
              <span className="lp-pal-ic">{c.icon}</span>
              {c.label}
              <span className="lp-pal-keys">
                {c.keys.map((k, j) => (
                  <Kbd key={j}>{k}</Kbd>
                ))}
              </span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---- bento mini-UIs ---- */

function MiniInbox() {
  return (
    <div className="lp-mini lp-mini-inbox">
      {INBOX.slice(0, 4).map((m, i) => (
        <MailRow key={m.subject} m={m} active={i === 1} />
      ))}
    </div>
  );
}

function MiniPalette() {
  return (
    <div className="lp-mini lp-pal lp-pal-flat">
      <div className="lp-pal-input">
        send<span className="lp-caret" />
      </div>
      <div className="lp-pal-list">
        <span className="lp-pal-item" data-on="true">
          <span className="lp-pal-ic">
            <SendIcon size={15} />
          </span>
          Send and archive
          <span className="lp-pal-keys">
            <Kbd>⌘</Kbd>
            <Kbd>↵</Kbd>
          </span>
        </span>
        <span className="lp-pal-item">
          <span className="lp-pal-ic">
            <ReplyIcon size={15} />
          </span>
          Reply with availability
        </span>
      </div>
    </div>
  );
}

const CAL = [
  { d: "Mon", e: [{ t: 24, h: 16, l: "Standup" }] },
  { d: "Tue", e: [{ t: 42, h: 24, l: "Q3 review" }] },
  { d: "Wed", e: [] },
  { d: "Thu", e: [{ t: 18, h: 18, l: "1:1 Dev" }, { t: 60, h: 18, l: "Design" }] },
  { d: "Fri", e: [{ t: 34, h: 20, l: "Ship" }] },
];

function MiniCalendar() {
  return (
    <div className="lp-mini lp-cal">
      <div className="lp-cal-head">
        {CAL.map((c) => (
          <span key={c.d} className="lp-cal-dayname">
            {c.d}
          </span>
        ))}
      </div>
      <div className="lp-cal-grid">
        {CAL.map((c, i) => (
          <span className="lp-cal-col" key={c.d} data-today={i === 3}>
            {c.e.map((ev) => (
              <span
                key={ev.l}
                className="lp-cal-event"
                style={{ top: `${ev.t}%`, height: `${ev.h}%` }}
              >
                {ev.l}
              </span>
            ))}
          </span>
        ))}
      </div>
    </div>
  );
}

function MiniAgent() {
  return (
    <div className="lp-mini lp-agent">
      <div className="lp-agent-msg" data-role="user">
        Reply to Priya that Thursday 2pm works, and add it to my calendar.
      </div>
      <div className="lp-agent-tool" data-done="true">
        Drafted reply
      </div>
      <div className="lp-agent-tool" data-done="true">
        Created event · Thu 2:00 PM
      </div>
      <div className="lp-agent-msg" data-role="assistant">
        Done. I replied to <strong>Priya Nair</strong> and put a 30-minute hold
        on your calendar.
      </div>
    </div>
  );
}

function BentoCard({
  label,
  title,
  body,
  keys,
  wide,
  children,
}: {
  label: string;
  title: string;
  body: string;
  keys?: string[];
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <article className="lp-bento-card lp-rise" data-wide={wide}>
      <div className="lp-bento-visual">{children}</div>
      <div className="lp-bento-copy">
        <p className="lp-label tnum">{label}</p>
        <h3 className="lp-bento-title">{title}</h3>
        <p className="lp-bento-body">{body}</p>
        {keys && (
          <p className="lp-bento-keys">
            {keys.map((k, i) => (
              <Kbd key={i}>{k}</Kbd>
            ))}
          </p>
        )}
      </div>
    </article>
  );
}

/* ---- bits ---- */

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
  const spring = useSpring(0, { mass: 1, stiffness: 80, damping: 24 });
  const display = useTransform(spring, (c) => Math.round(c).toLocaleString("en-US"));
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

const U1 = "M3 8 C 36 4, 104 4, 137 8";
const U2 = "M3 7 C 36 11, 104 3, 137 9";
const U3 = "M3 9 C 36 4, 104 11, 137 5";

/** A hand-drawn underline that morphs between waves under the accent word. */
function MorphUnderline() {
  return (
    <svg className="lp-underline-svg" viewBox="0 0 140 13" fill="none" aria-hidden="true">
      <motion.path
        stroke="var(--color-accent)"
        strokeWidth={2.5}
        strokeLinecap="round"
        initial={{ d: U1, pathLength: 0 }}
        animate={{ d: [U1, U2, U3, U1], pathLength: 1 }}
        transition={{
          d: { duration: 7, repeat: Infinity, ease: "easeInOut" },
          pathLength: { duration: 0.9, delay: 0.7, ease: "easeOut" },
        }}
      />
    </svg>
  );
}

// A soft, blurred light beam that blooms into the hero on load — the Aceternity
// "spotlight" look, sky-tinted and dark-theme only. Pure SVG + CSS, no JS.
function Spotlight() {
  return (
    <svg
      className="lp-spotlight"
      viewBox="0 0 3787 2842"
      fill="none"
      aria-hidden="true"
    >
      <g filter="url(#lp-spot-blur)">
        <ellipse
          cx="1924.71"
          cy="273.501"
          rx="1924.71"
          ry="273.501"
          transform="matrix(-0.822377 -0.568943 -0.568943 0.822377 3631.88 2291.09)"
          fill="var(--lp-spot-fill)"
          fillOpacity="0.16"
        />
      </g>
      <defs>
        <filter
          id="lp-spot-blur"
          x="0.860352"
          y="0.838989"
          width="3785.16"
          height="2840.26"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend
            mode="normal"
            in="SourceGraphic"
            in2="BackgroundImageFix"
            result="shape"
          />
          <feGaussianBlur stdDeviation="151" result="lp-spot-blur-effect" />
        </filter>
      </defs>
    </svg>
  );
}

// Deterministic PRNG (mulberry32) so seeded mote positions match SSR and client.
function moteRng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Mote = {
  x: number;
  y: number;
  s: number;
  o: number;
  dur: number;
  tw: number;
  delay: number;
  w: number;
};

function buildMotes(count: number): Mote[] {
  const rand = moteRng(7138);
  const motes: Mote[] = [];
  // Cluster centre + radii — sits on the spotlight's bright core (upper-left).
  const CX = 32;
  const CY = 17;
  const RX = 27;
  const RY = 19;
  for (let i = 0; i < count; i++) {
    // Radial scatter around the beam centre, denser toward the middle, so the
    // motes read as concentrated in the light rather than spread across the hero.
    const a = rand() * Math.PI * 2;
    const r = Math.pow(rand(), 0.6);
    motes.push({
      x: +Math.max(2, Math.min(70, CX + Math.cos(a) * r * RX)).toFixed(2),
      y: +Math.max(1, Math.min(46, CY + Math.sin(a) * r * RY)).toFixed(2),
      s: +(2 + rand() * 3.5).toFixed(1),
      o: +(0.25 + rand() * 0.4).toFixed(2),
      dur: +(6 + rand() * 7).toFixed(1),
      tw: +(2.5 + rand() * 3.5).toFixed(1),
      // Negative: each mote starts mid-cycle, so the field is already drifting
      // (and desynced) on load instead of snapping out of a shared origin.
      delay: +(-(rand() * 12)).toFixed(1),
      w: i % 5,
    });
  }
  return motes;
}

const MOTES = buildMotes(28);

// Fine motes drifting in the spotlight — dust caught in a sunbeam. Pure CSS,
// seeded for SSR safety, masked to the beam so they only glow where it's lit.
function Motes() {
  return (
    <div className="lp-motes" aria-hidden="true">
      {MOTES.map((m, i) => (
        <span
          key={i}
          className="lp-mote"
          style={
            {
              top: `${m.y}%`,
              left: `${m.x}%`,
              width: m.s,
              height: m.s,
              "--wander": `lp-mote-w${m.w}`,
              "--o": m.o,
              animationDuration: `${m.dur}s, ${m.tw}s`,
              animationDelay: `${m.delay}s, ${m.delay}s`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}

function SectionHead({ label, title }: { label: string; title: React.ReactNode }) {
  return (
    <div className="lp-head lp-rise">
      <p className="lp-label tnum">{label}</p>
      <h2 className="lp-title">{title}</h2>
    </div>
  );
}

export function Landing() {
  const [error, setError] = useState<string | null>(null);
  const heroRef = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({
    target: heroRef,
    offset: ["start start", "end start"],
  });
  const winY = useTransform(scrollYProgress, [0, 1], [0, -90]);
  const navRef = useRef<HTMLElement>(null);
  useLenis();
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("error");
    if (code) setError(ERRORS[code] ?? "Something went wrong. Please try again.");
  }, []);
  // Full-width at the top, morphs to the floating pill once scrolled.
  useEffect(() => {
    const onScroll = () => {
      navRef.current?.setAttribute(
        "data-scrolled",
        window.scrollY > 16 ? "true" : "false",
      );
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="lp">

      <nav className="lp-nav" ref={navRef} data-scrolled="false">
        <span className="lp-brand">
          <BrandMark size={18} />
          {siteConfig.name}
        </span>
        <div className="lp-nav-links">
          <a href="#features">Features</a>
          <a href="#compare">Compare</a>
          <a href="#faq">FAQ</a>
        </div>
        <span className="topbar-spacer" />
        <LandingThemeToggle />
        <button
          type="button"
          className="btn btn-primary lp-nav-cta"
          onClick={() => {
            // Drive the hero's connect form (reusing its Turnstile token) and
            // scroll it into view so a still-verifying state is visible —
            // `href="#start"` did nothing when already at the top of the page.
            const form = document.getElementById(
              "hero-connect",
            ) as HTMLFormElement | null;
            form?.scrollIntoView({ behavior: "smooth", block: "center" });
            form?.requestSubmit();
          }}
        >
          Connect Google
        </button>
      </nav>

      <main>
        {/* hero */}
        <section className="lp-hero" id="start" ref={heroRef}>
          <Spotlight />
          <Motes />
          <span className="lp-rise" style={{ animationDelay: "0s" }}>
            <HelmGlyph size={66} />
          </span>
          <p className="lp-eyebrow tnum lp-rise" style={{ animationDelay: "0.06s" }}>
            KEYBOARD-FIRST · GMAIL + CALENDAR
          </p>
          <h1 className="lp-rise" style={{ animationDelay: "0.12s" }}>
            Your inbox at the
            <br />
            speed of{" "}
            <span className="lp-serif lp-underline">
              thought
              <MorphUnderline />
            </span>
            .
          </h1>
          <p className="lp-sub lp-rise" style={{ animationDelay: "0.18s" }}>
            {siteConfig.name} puts Gmail and Google Calendar in one fast window
            where every action — triage, reply, search, schedule — is a single
            keystroke. Stop clicking through your day.
          </p>
          <div className="lp-cta-row lp-rise" style={{ animationDelay: "0.24s" }}>
            <ConnectGoogle
              formId="hero-connect"
              withArrow
              secondary={{ href: "#features", label: "See it fly" }}
            />
          </div>
          {error && <p className="error lp-error">{error}</p>}
          <p className="lp-fine lp-rise" style={{ animationDelay: "0.32s" }}>
            Free during beta · Connects securely through Corsair · Your password
            is never shared
          </p>

          <div className="lp-stage lp-rise" style={{ animationDelay: "0.28s" }}>
            <motion.div style={{ y: winY }}>
              <HeroWindow />
            </motion.div>
          </div>
        </section>

        {/* proof strip */}
        <section className="lp-strip lp-rise">
          <span><Kbd>J</Kbd> <Kbd>K</Kbd> fly through mail</span>
          <span><Kbd>R</Kbd> reply</span>
          <span><Kbd>E</Kbd> archive</span>
          <span><Kbd>G</Kbd> jump anywhere</span>
          <span><Kbd>⌘</Kbd> <Kbd>K</Kbd> everything else</span>
          <span><Kbd>⌘</Kbd> <Kbd>↵</Kbd> send</span>
        </section>

        {/* bento showcase */}
        <section className="lp-features" id="features">
          <SectionHead
            label="THE WORKSPACE"
            title={<>Everything, one keystroke away</>}
          />
          <div className="lp-bento">
            <BentoCard
              wide
              label="TRIAGE"
              title="Fly through your inbox"
              body="J and K move, E archives, R replies, # trashes. Clear a morning's mail without lifting your hands from the keys."
              keys={["J", "K", "E"]}
            >
              <MiniInbox />
            </BentoCard>
            <BentoCard
              label="COMMAND · ⌘K"
              title="One palette for everything"
              body="Start typing and Helm surfaces the command — compose, search, schedule, run the agent."
              keys={["⌘", "K"]}
            >
              <MiniPalette />
            </BentoCard>
            <BentoCard
              label="CALENDAR"
              title="Your week, a key away"
              body="Mail and calendar in one window. Turn an email into an event in a single keystroke."
              keys={["G", "C"]}
            >
              <MiniCalendar />
            </BentoCard>
            <BentoCard
              wide
              label="AGENT"
              title="An assistant that actually acts"
              body="Ask in plain language. It drafts the reply, books the meeting, and clears the thread — every destructive step gated behind your confirmation."
            >
              <MiniAgent />
            </BentoCard>
          </div>
        </section>

        {/* stats */}
        <section className="lp-stats lp-rise">
          <div className="lp-stat">
            <span className="lp-stat-num tnum"><AnimatedNumber value={0} /></span>
            <span className="lp-stat-label">clicks to clear an inbox</span>
          </div>
          <div className="lp-stat">
            <span className="lp-stat-num tnum"><AnimatedNumber value={30} suffix="+" /></span>
            <span className="lp-stat-label">keyboard shortcuts</span>
          </div>
          <div className="lp-stat">
            <span className="lp-stat-num tnum"><AnimatedNumber value={2} /></span>
            <span className="lp-stat-label">Google apps, one window</span>
          </div>
          <div className="lp-stat">
            <span className="lp-stat-num tnum"><AnimatedNumber value={1} prefix="under " suffix="s" /></span>
            <span className="lp-stat-label">cached lists and search</span>
          </div>
        </section>

        {/* comparison */}
        <section className="lp-section" id="compare">
          <SectionHead label="COMPARE" title="The speed of Superhuman, the price of neither" />
          <div className="lp-compare-wrap lp-rise">
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
                <tr><td>Keyboard-first triage</td><td data-accent="true">Yes</td><td>Partial</td><td>Yes</td></tr>
                <tr><td>Mail and calendar in one window</td><td data-accent="true">Yes</td><td className="lp-no">—</td><td>Partial</td></tr>
                <tr><td>Email to calendar event in one key</td><td data-accent="true">Yes</td><td className="lp-no">—</td><td>Yes</td></tr>
                <tr><td>Sub-second cached search</td><td data-accent="true">Yes</td><td className="lp-no">—</td><td>Yes</td></tr>
                <tr><td>An agent that acts for you</td><td data-accent="true">Yes</td><td className="lp-no">—</td><td>Partial</td></tr>
                <tr><td>Price</td><td data-accent="true">Free beta</td><td>Free</td><td>$25+/mo</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* trust */}
        <section className="lp-section" id="trust">
          <SectionHead label="YOUR DATA" title="Your account stays yours" />
          <div className="lp-trust">
            <div className="lp-trust-row lp-rise">
              <span className="lp-trust-label tnum">YOUR ACCOUNT</span>
              <p>Connects through Google OAuth. {siteConfig.name} never sees your password, and you can revoke access from your Google account at any time.</p>
            </div>
            <div className="lp-trust-row lp-rise">
              <span className="lp-trust-label tnum">YOUR DATA</span>
              <p>Messages are mirrored into an encrypted store so search and browsing feel instant. Never sold, never used for training.</p>
            </div>
            <div className="lp-trust-row lp-rise">
              <span className="lp-trust-label tnum">YOUR KEYS</span>
              <p>Every token is envelope-encrypted with a key that stays on the server — handled by Corsair and Postgres, isolated per user.</p>
            </div>
          </div>
        </section>

        {/* faq */}
        <section className="lp-section" id="faq">
          <SectionHead label="FAQ" title="Questions, answered" />
          <div className="lp-faq lp-rise">
            <details>
              <summary>Is my email stored?</summary>
              <p>Headers and snippets are cached in an encrypted database so lists and search are instant. Full messages are fetched live from Gmail when you open them. Disconnecting your account removes the cache.</p>
            </details>
            <details>
              <summary>What does {siteConfig.name} cost?</summary>
              <p>Nothing during the beta. If that changes, connected users hear about it first — there are no surprise charges.</p>
            </details>
            <details>
              <summary>Does it work with Google Workspace accounts?</summary>
              <p>Yes — any Google account works. Some Workspace organisations require an admin to allow third-party access first.</p>
            </details>
            <details>
              <summary>Why does Google show an unverified-app screen?</summary>
              <p>{siteConfig.name} is in beta and Google&apos;s verification is in progress. Choose Advanced, then Continue — the permissions requested are only Gmail and Calendar.</p>
            </details>
          </div>
        </section>

        {/* final CTA */}
        <section className="lp-final">
          <div className="lp-final-inner lp-rise">
            <HelmGlyph size={56} />
            <h2>Take the helm of your inbox.</h2>
            <p className="lp-final-sub">One consent, then it&apos;s all keyboard. Free during the beta.</p>
            <ConnectGoogle withArrow />
          </div>
        </section>
      </main>

      <footer className="lp-foot">
        <div className="lp-foot-row">
          <span className="lp-brand">
            <BrandMark size={15} />
            {siteConfig.name}
          </span>
          <div className="lp-foot-links">
            <a href="#features">Features</a>
            <a href="#compare">Compare</a>
            <a href="#faq">FAQ</a>
          </div>
          <span className="topbar-spacer" />
          <span className="lp-foot-note tnum">
            Built with Next.js, Postgres and Corsair
          </span>
        </div>
        <nav className="lp-foot-legal" aria-label="Legal">
          <a href="/privacy-policy">Privacy Policy</a>
          <a href="/terms">Terms &amp; Conditions</a>
          <a href="/refund-policy">Cancellation &amp; Refund</a>
          <a href="/shipping-policy">Shipping &amp; Delivery</a>
          <a href="/contact">Contact Us</a>
        </nav>
      </footer>
    </div>
  );
}
