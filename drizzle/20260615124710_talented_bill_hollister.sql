CREATE TABLE "calendar_watch" (
	"channel_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"resource_id" text,
	"expiration" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "calendar_watch_tenant_idx" ON "calendar_watch" USING btree ("tenant_id");