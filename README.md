# Helm

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
cp .env.example .env        # then fill in DATABASE_URL and CORSAIR_KEK
pnpm db:push                # apply the schema
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
- `pnpm db:push` / `pnpm db:studio` — schema sync and inspection
