"use client";

import { useRef, useState, type ReactNode } from "react";
import { Turnstile } from "@marsidev/react-turnstile";

import { env } from "@/env";

const SITE_KEY = env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

const Arrow = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path
      d="M3 8h10m0 0L9 4m4 4L9 12"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * "Connect Google" CTA. Posts to /api/oauth/start, carrying a Cloudflare
 * Turnstile token so the OAuth funnel (and tenant minting) is gated against
 * bots. When the site key is unset the widget is omitted and the form posts
 * plainly — the server skips the check too, so dev still connects.
 *
 * The token usually arrives before the click (auto-solve); if the user clicks
 * first, the submit is deferred and fired the moment the token lands, so the
 * button is never left disabled waiting on the widget.
 */
export function ConnectGoogle({
  className = "btn btn-primary lp-cta",
  children = "Connect Google",
  withArrow = false,
  secondary,
}: {
  className?: string;
  children?: ReactNode;
  withArrow?: boolean;
  secondary?: { href: string; label: string };
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const hiddenRef = useRef<HTMLInputElement>(null);
  const tokenRef = useRef<string | null>(null);
  const wantSubmit = useRef(false);
  const [verifying, setVerifying] = useState(false);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    if (!SITE_KEY) return; // Turnstile off → native POST proceeds
    if (tokenRef.current) return; // already verified → proceed
    event.preventDefault(); // wait for the token, then auto-submit
    wantSubmit.current = true;
    setVerifying(true);
  }

  function handleToken(token: string) {
    tokenRef.current = token;
    if (hiddenRef.current) hiddenRef.current.value = token;
    if (wantSubmit.current) {
      wantSubmit.current = false;
      setVerifying(false);
      formRef.current?.requestSubmit();
    }
  }

  function resetToken() {
    tokenRef.current = null;
    if (hiddenRef.current) hiddenRef.current.value = "";
    wantSubmit.current = false;
    setVerifying(false);
  }

  return (
    <form
      ref={formRef}
      method="POST"
      action="/api/oauth/start"
      onSubmit={onSubmit}
      className="lp-connect"
    >
      <div className="lp-connect-buttons">
        <button type="submit" className={className} disabled={verifying}>
          {verifying ? "Verifying…" : children}
          {withArrow && !verifying && <Arrow />}
        </button>
        {secondary && (
          <a className="btn lp-cta lp-cta-ghost" href={secondary.href}>
            {secondary.label}
          </a>
        )}
      </div>
      <input
        ref={hiddenRef}
        type="hidden"
        name="cf-turnstile-response"
        defaultValue=""
      />
      {SITE_KEY && (
        <Turnstile
          siteKey={SITE_KEY}
          options={{ theme: "auto", size: "normal", responseField: false }}
          onSuccess={handleToken}
          onExpire={resetToken}
          onError={resetToken}
          className="lp-turnstile"
        />
      )}
    </form>
  );
}
