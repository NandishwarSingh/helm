CREATE TABLE "mail_sync" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"next_page_token" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
