import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { env } from "@/env";
import {
  getProStatus,
  getSubscriberId,
  upsertSubscription,
} from "@/server/lib/billing";
import {
  createRazorpaySubscription,
  razorpayConfigured,
  verifySubscriptionPayment,
} from "@/server/lib/razorpay";
import { getActiveAccount } from "@/server/lib/users";
import { authedProcedure, createTRPCRouter } from "@/server/api/trpc";

export const billingRouter = createTRPCRouter({
  // Whether the session is Pro, plus whether payments are even enabled (so the
  // client can show a graceful state when Razorpay isn't configured yet).
  status: authedProcedure.query(async () => {
    return { ...(await getProStatus()), configured: razorpayConfigured() };
  }),

  // Start a ₹99/month subscription: create it on Razorpay, record it, and return
  // the id + public key for Checkout. Refuses cleanly when payments aren't set up.
  subscribe: authedProcedure.mutation(async () => {
    if (!razorpayConfigured()) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Payments aren't enabled yet — please check back soon.",
      });
    }
    const subscriberId = await getSubscriberId();
    if (!subscriberId) throw new TRPCError({ code: "UNAUTHORIZED" });

    const email = (await getActiveAccount())?.email;
    const subscriptionId = await createRazorpaySubscription(email);
    await upsertSubscription({
      subscriberId,
      razorpaySubscriptionId: subscriptionId,
      status: "created",
    });
    return { subscriptionId, keyId: env.RAZORPAY_KEY_ID! };
  }),

  // Verify the Checkout callback signature and mark the session Pro. The webhook
  // remains the source of truth for ongoing status (renewals, cancellations).
  verify: authedProcedure
    .input(
      z.object({
        paymentId: z.string().min(1).max(256),
        subscriptionId: z.string().min(1).max(256),
        signature: z.string().min(1).max(512),
      }),
    )
    .mutation(async ({ input }) => {
      const subscriberId = await getSubscriberId();
      if (!subscriberId) throw new TRPCError({ code: "UNAUTHORIZED" });
      if (
        !verifySubscriptionPayment(
          input.paymentId,
          input.subscriptionId,
          input.signature,
        )
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Payment could not be verified.",
        });
      }
      await upsertSubscription({
        subscriberId,
        razorpaySubscriptionId: input.subscriptionId,
        status: "active",
      });
      return { ok: true };
    }),
});
