CREATE TABLE "subscriptions" (
	"subscriber_id" text PRIMARY KEY NOT NULL,
	"razorpay_subscription_id" text,
	"status" text DEFAULT 'inactive' NOT NULL,
	"current_end" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "subscriptions_rzp_idx" ON "subscriptions" USING btree ("razorpay_subscription_id");