"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

import { useProCheckout } from "@/app/_components/use-pro-checkout";
import { CloseIcon } from "@/components/icons";
import { scrim, slideOver } from "@/lib/motion";
import { useFocusTrap } from "@/lib/use-focus-trap";
import { api } from "@/trpc/react";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * Upsell shown when a free session tries to add a second mailbox. Connecting
 * more than the primary account is a Pro entitlement enforced server-side
 * (/oauth/start + linkAddedAccount) — this modal only sells the upgrade. A
 * verified payment refreshes billing.status and closes the modal; the user can
 * then add the account (the server now lets the consent through).
 */
export function ProUpsell({ open, onOpenChange }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open);
  const { upgrade, busy, error } = useProCheckout();

  // Demo unlock: flips the active account to Pro instantly (no card) so a
  // hackathon reviewer can try the Pro features. Payments above are the real
  // path; this just calls the labelled `billing.activateDemo` mutation and
  // refreshes status so every `billing.status` consumer flips to Pro.
  const utils = api.useUtils();
  const activateDemo = api.billing.activateDemo.useMutation();
  const [demoError, setDemoError] = useState<string | null>(null);

  async function unlockDemo() {
    if (activateDemo.isPending) return;
    setDemoError(null);
    try {
      await activateDemo.mutateAsync();
      await utils.billing.status.invalidate();
      onOpenChange(false);
    } catch {
      setDemoError("Couldn't unlock the demo — please try again.");
    }
  }

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onOpenChange(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="scrim"
            variants={scrim}
            initial="initial"
            animate="animate"
            exit="exit"
            onClick={() => onOpenChange(false)}
          />
          <motion.div
            ref={dialogRef}
            className="compose pro-upsell"
            variants={slideOver}
            initial="initial"
            animate="animate"
            exit="exit"
            role="dialog"
            aria-modal="true"
            aria-label="Unlock Helm Pro"
          >
            <div className="compose-head">
              Unlock Helm Pro
              <span className="topbar-spacer" />
              <button
                type="button"
                className="icon-btn"
                onClick={() => onOpenChange(false)}
                aria-label="Close"
              >
                <CloseIcon size={16} />
              </button>
            </div>
            <div className="compose-body pro-upsell-body">
              <p className="pro-upsell-lead">
                Go further with <strong>Helm Pro</strong>.
              </p>
              <ul className="pro-upsell-perks">
                <li>Up to six Google accounts in one unified inbox</li>
                <li>Bulk-unsubscribe from newsletters in a few taps</li>
                <li>Switch and fan out across every mailbox</li>
                <li>Everything in the free plan, no limits</li>
              </ul>
              {error && <p className="error">{error}</p>}
              <button
                type="button"
                className="btn btn-primary pro-upsell-cta"
                onClick={() => void upgrade(() => onOpenChange(false))}
                disabled={busy}
              >
                {busy ? "Opening…" : "Upgrade to Pro — ₹99/month"}
              </button>
              <p className="pro-upsell-fine">
                Billed monthly via Razorpay. Cancel anytime.
              </p>

              <div className="pro-upsell-or" aria-hidden="true">
                <span>for the hackathon demo</span>
              </div>
              <p className="pro-upsell-demo-note">
                Payments are fully implemented (Razorpay above). You can also
                unlock Pro instantly for this demo — no card needed.
              </p>
              {demoError && <p className="error">{demoError}</p>}
              <button
                type="button"
                className="btn pro-upsell-demo"
                onClick={() => void unlockDemo()}
                disabled={activateDemo.isPending}
              >
                {activateDemo.isPending
                  ? "Unlocking…"
                  : "Activate Pro for demo (no payment)"}
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
