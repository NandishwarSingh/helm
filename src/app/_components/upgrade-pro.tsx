"use client";

import { useState } from "react";

import { api } from "@/trpc/react";

type RzpResponse = {
  razorpay_payment_id: string;
  razorpay_subscription_id: string;
  razorpay_signature: string;
};
type RzpOptions = {
  key: string;
  subscription_id: string;
  name: string;
  description: string;
  theme?: { color?: string };
  handler: (resp: RzpResponse) => void;
  modal?: { ondismiss?: () => void };
};
declare global {
  interface Window {
    Razorpay?: new (options: RzpOptions) => { open: () => void };
  }
}

const CHECKOUT_SRC = "https://checkout.razorpay.com/v1/checkout.js";

function loadCheckout(): Promise<boolean> {
  return new Promise((resolve) => {
    if (window.Razorpay) return resolve(true);
    const s = document.createElement("script");
    s.src = CHECKOUT_SRC;
    s.async = true;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.body.appendChild(s);
  });
}

function Spark() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 1l1.6 4.4L14 7l-4.4 1.6L8 13l-1.6-4.4L2 7l4.4-1.6L8 1z"
        fill="currentColor"
      />
    </svg>
  );
}

/** Rail CTA: starts a ₹99/month Helm Pro subscription via Razorpay Checkout. */
export function UpgradePro() {
  const utils = api.useUtils();
  const status = api.billing.status.useQuery(undefined, { staleTime: 60_000 });
  const subscribe = api.billing.subscribe.useMutation();
  const verify = api.billing.verify.useMutation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Until we know the state, render nothing (avoids a flash of the wrong CTA).
  if (status.isLoading) return null;
  if (status.data?.pro) {
    return (
      <div className="pro-badge" title="Helm Pro is active">
        <Spark /> Helm Pro
      </div>
    );
  }

  async function upgrade() {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const loaded = await loadCheckout();
      if (!loaded || !window.Razorpay) {
        throw new Error("Could not load the payment form.");
      }
      const { subscriptionId, keyId } = await subscribe.mutateAsync();
      const rzp = new window.Razorpay({
        key: keyId,
        subscription_id: subscriptionId,
        name: "Helm",
        description: "Helm Pro — ₹99/month",
        theme: { color: "#0284c7" },
        handler: (resp) => {
          void verify
            .mutateAsync({
              paymentId: resp.razorpay_payment_id,
              subscriptionId: resp.razorpay_subscription_id,
              signature: resp.razorpay_signature,
            })
            .then(() => utils.billing.status.invalidate())
            .catch(() =>
              setError("Payment received — verifying, refresh in a moment."),
            );
        },
        modal: { ondismiss: () => setBusy(false) },
      });
      rzp.open();
      setBusy(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setBusy(false);
    }
  }

  return (
    <div className="upgrade-pro-wrap">
      <button
        type="button"
        className="upgrade-pro"
        onClick={() => void upgrade()}
        disabled={busy}
      >
        <Spark />
        {busy ? "Opening…" : "Upgrade to Pro"}
      </button>
      {error && <span className="upgrade-pro-err">{error}</span>}
    </div>
  );
}
