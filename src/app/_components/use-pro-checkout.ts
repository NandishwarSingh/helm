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

/**
 * Shared Razorpay Checkout flow for "start Helm Pro": creates the subscription
 * server-side, opens Checkout, verifies the signature, then refreshes billing
 * status so every `billing.status` consumer (the topbar badge, the add-account
 * gate) flips to Pro. Used by both the topbar CTA and the account upsell modal.
 * `onDone` fires after a verified payment (e.g. to close the upsell). The actual
 * entitlement is enforced server-side; this only drives the purchase UI.
 */
export function useProCheckout() {
  const utils = api.useUtils();
  const subscribe = api.billing.subscribe.useMutation();
  const verify = api.billing.verify.useMutation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upgrade(onDone?: () => void) {
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
            .then(() => onDone?.())
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

  return { upgrade, busy, error };
}
