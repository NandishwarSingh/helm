<p align="center">
  <img src="docs/hero.png" alt="Helm — your inbox at the speed of thought" width="100%" />
</p>

# Helm

**Live → [helm.houndcode.com](https://helm.houndcode.com)**

A keyboard-first command center for Gmail and Google Calendar. Helm puts
search, triage, scheduling and replies a keystroke away, so email and calendar
work takes fewer steps than the default web apps.

Every Gmail and Google Calendar action runs through [Corsair](https://corsair.dev),
which handles OAuth, token refresh, webhooks and a local Postgres cache of every
synced message and event.

## Stack

- **Next.js** (App Router) and **tRPC** for an end-to-end typed API
- **Postgres** with **Drizzle** — also Corsair's entity cache
- **Corsair** for the Gmail and Google Calendar integrations
- **Motion** for interface animation

## Corsair features used

Every Gmail and Calendar operation goes through Corsair — there is no direct
Google API call in the app.

- **Gmail plugin** — cached reads (`gmail.db.messages.search` / `list`) and live
  writes (`gmail.api.messages.send` / `modify` / `trash` / `batchModify`,
  `gmail.api.drafts.create` / `update` / `send` / `delete`)
- **Google Calendar plugin** — cached reads (`googlecalendar.db.events.list` /
  `search`) and live writes (`googlecalendar.api.events.create` / `update` /
  `delete` / `getMany`)
- **OAuth + token refresh** — handled by Corsair, per tenant
- **Postgres entity cache** — every synced message and event is cached locally;
  `.db.*` reads never touch Google
- **Webhooks** — `processWebhook` consumes Gmail Pub/Sub and Calendar push
  channels at `/api/webhooks` for realtime updates (no polling)
- **Search API** — `gmail.db.messages.search` with operator filters powers
  advanced search
- **MCP** — `@corsair-dev/mcp` (`buildCorsairToolDefs`) exposes the Gmail and
  Calendar operations as agent tools, with a sandboxed `run_script`
- **Multi-tenant** — `corsair.withTenant` scopes every operation to the active
  connected account

## Bonus tasks attempted

All six bonus tasks from the brief, plus a command palette:

- ✅ **Corsair MCP agent chat** — chat to send mail and create/modify calendar
  invites (`src/server/lib/corsair-mcp.ts`, `src/app/api/agent/route.ts`)
- ✅ **Realtime webhooks** — Gmail + Calendar push through Corsair, no polling
  (`src/app/api/webhooks/route.ts`)
- ✅ **Priority filtering via a cheap LLM** — subject + body classified by
  `deepseek/deepseek-v4-flash` into urgent / reply / fyi / low
  (`src/server/lib/triage.ts`)
- ✅ **Keyboard shortcuts** — `j`/`k` navigation, `g`-prefixed view jumps,
  single-key actions (compose, archive, star, new event, …)
- ✅ **Corsair search API** — operator-aware advanced Gmail search
  (`from:` / `to:` / `subject:` / `is:…`) over the cache
- ✅ **Vector search (sub-second, local)** — pgvector embeddings over the cached
  mail, cosine KNN (`src/server/lib/semantic-search.ts`)
- ✅ **Command palette** — ⌘K (`src/components/command-palette.tsx`)

## Architecture

- `src/server/corsair.ts` — Corsair client (Gmail + Calendar plugins, multi-tenant)
- `src/server/api/routers/*` — tRPC routers; `.db.*` reads hit the cache, `.api.*` writes hit Google
- `src/app/api/webhooks/route.ts` — receives Corsair webhooks to keep the cache fresh
- `src/app/_components/*` — the mail and calendar surfaces
- `src/config/site.ts` — single source of truth for branding and SEO

## Local setup

Requires Node 20+, pnpm and a Postgres instance.

```bash
pnpm install
cp .env.example .env        # then fill in the values
pnpm db:migrate             # apply the schema migrations
pnpm dev
```

### Connect Corsair

Create a Google Cloud project, enable the Gmail and Google Calendar APIs, then:

```bash
pnpm corsair setup --gmail client_id=... client_secret=...
pnpm corsair setup --googlecalendar client_id=... client_secret=...
pnpm corsair auth --plugin=gmail --tenant=dev
pnpm corsair auth --plugin=googlecalendar --tenant=dev
pnpm corsair auth --plugin=gmail --webhooks
pnpm corsair auth --plugin=googlecalendar --webhooks
```

For local webhook delivery, expose `/api/webhooks` with a tunnel and register
that URL during webhook setup.

## Scripts

- `pnpm dev` — start the dev server
- `pnpm build` — production build
- `pnpm typecheck` — types only
- `pnpm db:generate` / `pnpm db:migrate` — create and apply timestamped migrations
- `pnpm db:studio` — inspect the database
