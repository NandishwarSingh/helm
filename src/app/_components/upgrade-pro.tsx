"use client";

import { api } from "@/trpc/react";

type Props = {
  /** Open the Pro upsell modal (real Razorpay checkout + the demo unlock). */
  onUpgrade: () => void;
};

/**
 * Topbar CTA. Opens the Pro upsell modal — the single upgrade surface that holds
 * both the real ₹99/month Razorpay checkout and the no-payment demo unlock — so
 * the demo option is reachable from the most prominent entry point too.
 */
export function UpgradePro({ onUpgrade }: Props) {
  const status = api.billing.status.useQuery(undefined, { staleTime: 60_000 });

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
      onClick={onUpgrade}
      title="Unlock Helm Pro"
    >
      Upgrade to Pro
    </button>
  );
}
