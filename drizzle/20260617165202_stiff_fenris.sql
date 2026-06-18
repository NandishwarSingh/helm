CREATE TABLE "documents" (
	"tenant_id" text NOT NULL,
	"account_id" text NOT NULL,
	"message_id" text NOT NULL,
	"attachment_id" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"category" text NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"sender" text DEFAULT '' NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"received_at" timestamp with time zone,
	"content_hash" text NOT NULL,
	"text_extracted" boolean DEFAULT false NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"pinned_at" timestamp with time zone,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_tenant_id_message_id_attachment_id_pk" PRIMARY KEY("tenant_id","message_id","attachment_id")
);
--> statement-breakpoint
CREATE INDEX "documents_account_idx" ON "documents" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "documents_account_category_idx" ON "documents" USING btree ("account_id","category");--> statement-breakpoint
CREATE INDEX "documents_account_received_idx" ON "documents" USING btree ("account_id","received_at");--> statement-breakpoint
CREATE INDEX "documents_tenant_idx" ON "documents" USING btree ("tenant_id");