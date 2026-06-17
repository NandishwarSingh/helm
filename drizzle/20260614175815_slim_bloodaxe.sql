CREATE TABLE "gmail_watch" (
	"email" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
