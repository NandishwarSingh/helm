"use client";

import { useProCheckout } from "@/app/_components/use-pro-checkout";
import { api } from "@/trpc/react";

/** Rail CTA: starts a ₹99/month Helm Pro subscription via Razorpay Checkout. */
export function UpgradePro() {
  const status = api.billing.status.useQuery(undefined, { staleTime: 60_000 });
  const { upgrade, busy, error } = useProCheckout();

  // Nothing until we know the state (avoids flashing the wrong CTA in the topbar).
  if (status.isLoading) return null;
  if (status.data?.pro) {
    return (
      <span className="pro-badge" title="Helm Pro is active">
        Helm Pro
      </span>
    );
  }

  return (
    <button
      type="button"
      className="btn upgrade-pro"
      onClick={() => void upgrade()}
      disabled={busy}
      title={error ?? "Unlock Helm Pro"}
    >
      {busy ? "Opening…" : "Upgrade to Pro"}
    </button>
  );
}
