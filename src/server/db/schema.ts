import { pgTable, primaryKey, index, text, jsonb, timestamp, uniqueIndex, boolean } from 'drizzle-orm/pg-core';

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

// Maps a connected Gmail address to its tenant(s), so an incoming Pub/Sub push
// routes to the right realtime stream(s) and the renewal cron can re-arm every
// tenant's watch (a Gmail watch expires in ~7 days). The same mailbox can be
// connected from several browser sessions — each its own tenant — so the key is
// (email, tenant): they coexist instead of one silently hijacking the other's
// routing, and a push fans out to all of them.
export const gmailWatch = pgTable('gmail_watch', {
    email: text('email').notNull(),
    tenantId: text('tenant_id').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    primaryKey({ columns: [table.email, table.tenantId] }),
    // The renewal cron and watch teardown scan by tenant.
    index('gmail_watch_tenant_idx').on(table.tenantId),
]);

// ── Multi-account identity ──────────────────────────────────────────────────
// A durable user that owns one or more connected Google accounts. A user stays
// on the legacy single-tenant cookie until they connect a SECOND account, at
// which point a user row is materialized here and every account is linked. Each
// account remains its own Corsair tenant, so per-account mail/calendar data is
// isolated exactly as before — this layer only sits ABOVE tenants.
export const users = pgTable('users', {
    id: text('id').primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// One row per connected Google account. `tenantId` is that account's Corsair
// tenant; `email` is the verified address; `isPrimary` marks the default
// "from"/active account. Unique (user, email) blocks linking the same mailbox
// twice; unique tenant keeps one account row per tenant.
export const userAccounts = pgTable('user_accounts', {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id),
    tenantId: text('tenant_id').notNull(),
    email: text('email').notNull(),
    label: text('label'),
    color: text('color'),
    isPrimary: boolean('is_primary').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    uniqueIndex('user_accounts_user_email_uniq').on(table.userId, table.email),
    uniqueIndex('user_accounts_tenant_uniq').on(table.tenantId),
    index('user_accounts_user_idx').on(table.userId),
]);

// Maps a Google Calendar push channel to its tenant. Calendar pushes carry no
// body — just an X-Goog-Channel-Id header — so the tenant is looked up here to
// route + notify. Renewed by the cron (a channel expires) and torn down on
// account removal.
export const calendarWatch = pgTable('calendar_watch', {
    channelId: text('channel_id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    resourceId: text('resource_id'),
    expiration: text('expiration'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    index('calendar_watch_tenant_idx').on(table.tenantId),
]);

// ── Pro subscriptions (Razorpay) ────────────────────────────────────────────
// One row per billing identity: the session id (a user id for a multi-account
// session, else the active tenant id). Status is driven by Razorpay webhooks.
export const subscriptions = pgTable('subscriptions', {
    subscriberId: text('subscriber_id').primaryKey(),
    razorpaySubscriptionId: text('razorpay_subscription_id'),
    status: text('status').notNull().default('inactive'),
    currentEnd: timestamp('current_end', { withTimezone: true }),
    // Event time of the last webhook applied — older/out-of-order events are
    // ignored so a retried stale "charged" can't revive a cancelled sub.
    lastEventAt: timestamp('last_event_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    // Webhooks look the row up by the Razorpay subscription id.
    index('subscriptions_rzp_idx').on(table.razorpaySubscriptionId),
]);