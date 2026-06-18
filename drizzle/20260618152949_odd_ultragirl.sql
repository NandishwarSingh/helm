CREATE TABLE "unsubscribed_senders" (
	"tenant_id" text NOT NULL,
	"sender_email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unsubscribed_senders_tenant_id_sender_email_pk" PRIMARY KEY("tenant_id","sender_email")
);
