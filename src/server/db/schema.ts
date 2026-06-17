import { pgTable, primaryKey, index, text, jsonb, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const corsairIntegrations = pgTable('corsair_integrations', {
    id: text('id').primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    name: text('name').notNull(),
    config: jsonb('config').notNull().default({}),
    dek: text('dek'),
});

export const corsairAccounts = pgTable('corsair_accounts', {
    id: text('id').primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    tenantId: text('tenant_id').notNull(),
    integrationId: text('integration_id').notNull().references(() => corsairIntegrations.id),
    config: jsonb('config').notNull().default({}),
    dek: text('dek'),
}, (table) => [
    // One account per tenant per integration — concurrent OAuth completions
    // must converge on a single row.
    uniqueIndex('corsair_accounts_tenant_integration_uniq').on(table.tenantId, table.integrationId),
]);

export const corsairEntities = pgTable('corsair_entities', {
    id: text('id').primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    accountId: text('account_id').notNull().references(() => corsairAccounts.id),
    entityId: text('entity_id').notNull(),
    entityType: text('entity_type').notNull(),
    version: text('version').notNull(),
    data: jsonb('data').notNull().default({}),
}, (table) => [
    // Every cache read filters by account + type (messages, drafts, events);
    // without this each read scanned the whole entity table.
    index('corsair_entities_account_type_idx').on(table.accountId, table.entityType),
]);

export const corsairEvents = pgTable('corsair_events', {
    id: text('id').primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    accountId: text('account_id').notNull().references(() => corsairAccounts.id),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull().default({}),
    status: text('status'),
});

// Per-tenant cursor for paging deeper into Gmail when the cache is exhausted.
export const mailSync = pgTable('mail_sync', {
    tenantId: text('tenant_id').primaryKey(),
    nextPageToken: text('next_page_token'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// LLM triage verdicts. One row per message, written once — the permanent
// cache that keeps re-opening the Priority view free.
export const mailTriage = pgTable('mail_triage', {
    tenantId: text('tenant_id').notNull(),
    messageId: text('message_id').notNull(),
    priority: text('priority').notNull(),
    reason: text('reason').notNull().default(''),
    classifiedAt: timestamp('classified_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    primaryKey({ columns: [table.tenantId, table.messageId] }),
]);

// Maps a connected Gmail address to its tenant, so an incoming Pub/Sub push
// routes to the right user's realtime stream and the renewal cron can re-arm
// every tenant's watch (a Gmail watch expires in ~7 days). One row per address.
export const gmailWatch = pgTable('gmail_watch', {
    email: text('email').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});