"use client";

import { useEffect, useState } from "react";

import { BrandMark } from "@/components/brand-mark";
import { siteConfig } from "@/config/site";

const ERRORS: Record<string, string> = {
  denied: "Access was declined. Connect again when you're ready.",
  missing_code: "Sign-in didn't complete. Please try again.",
  bad_state: "Your sign-in link expired. Please try again.",
  oauth_callback: "Couldn't finish connecting. Please try again.",
};

export function ConnectScreen() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("error");
    if (code) setError(ERRORS[code] ?? "Something went wrong. Please try again.");
  }, []);

  return (
    <main className="connect">
      <div className="connect-inner">
        <div className="connect-brand">
          <BrandMark size={22} />
          {siteConfig.name}
        </div>

        <h1 className="connect-title">
          A faster way through Gmail and Google Calendar.
        </h1>
        <p className="connect-sub">{siteConfig.description}</p>

        <a className="btn btn-primary connect-cta" href="/api/oauth/start">
          Connect Google
        </a>

        {error && <p className="connect-error">{error}</p>}

        <p className="connect-fine">
          Gmail and Calendar connect securely through Corsair. Your Google
          password is never shared with {siteConfig.name}.
        </p>
      </div>
    </main>
  );
}
