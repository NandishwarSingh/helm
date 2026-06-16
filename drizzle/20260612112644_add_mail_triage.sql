CREATE TABLE "mail_triage" (
	"tenant_id" text NOT NULL,
	"message_id" text NOT NULL,
	"priority" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"classified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_triage_tenant_id_message_id_pk" PRIMARY KEY("tenant_id","message_id")
);
