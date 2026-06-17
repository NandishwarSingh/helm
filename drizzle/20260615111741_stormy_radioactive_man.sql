CREATE TABLE "user_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"email" text NOT NULL,
	"label" text,
	"color" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_accounts" ADD CONSTRAINT "user_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_accounts_user_email_uniq" ON "user_accounts" USING btree ("user_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "user_accounts_tenant_uniq" ON "user_accounts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "user_accounts_user_idx" ON "user_accounts" USING btree ("user_id");