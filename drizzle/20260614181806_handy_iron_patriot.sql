-- Drop the single-column email PK (Postgres default name "<table>_pkey",
-- verified on prod) and replace it with a composite (email, tenant_id) PK so the
-- same mailbox can be connected from several tenants. Add a tenant_id index for
-- the renewal cron / teardown scans. The table is empty in every environment at
-- this point, so the PK swap moves no rows.
ALTER TABLE "gmail_watch" DROP CONSTRAINT "gmail_watch_pkey";--> statement-breakpoint
ALTER TABLE "gmail_watch" ADD CONSTRAINT "gmail_watch_email_tenant_id_pk" PRIMARY KEY("email","tenant_id");--> statement-breakpoint
CREATE INDEX "gmail_watch_tenant_idx" ON "gmail_watch" USING btree ("tenant_id");
