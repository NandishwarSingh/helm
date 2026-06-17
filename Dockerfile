# Built in CI (off the RAM-tight VPS); ships only Next's standalone server.
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.11.1 --activate
WORKDIR /app

FROM base AS deps
# Toolchain to compile the isolated-vm native addon (the run_script sandbox).
RUN apk add --no-cache python3 make g++
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV SKIP_ENV_VALIDATION=1
ENV NEXT_TELEMETRY_DISABLED=1
# NEXT_PUBLIC_* are inlined at build time, so the site URL must be set here.
ARG NEXT_PUBLIC_SITE_URL=https://helm.houndcode.com
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
# Public Turnstile site key — inlined into the client bundle at build time.
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY
ENV NEXT_PUBLIC_TURNSTILE_SITE_KEY=$NEXT_PUBLIC_TURNSTILE_SITE_KEY
RUN pnpm build

# One-shot migrator: full deps + source so Drizzle migrations + the pgvector
# setup can run on the VPS (where Postgres lives) BEFORE the app starts. The
# runtime image is standalone-only and deliberately has no migration tooling, so
# this is built and run separately:
#   docker run --rm --network host --env-file .env <image>:migrate
FROM base AS migrate
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV SKIP_ENV_VALIDATION=1
ENV NODE_ENV=production
CMD ["sh", "-c", "pnpm db:migrate && pnpm db:vector"]

FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# libstdc++ is required by the isolated-vm native addon at runtime.
RUN apk add --no-cache libstdc++
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs
# Standalone output: minimal server + only the traced runtime deps.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
USER nextjs
EXPOSE 3000
# Real readiness signal so the deploy can gate on health (GET /api/webhooks
# returns {status:"ok"}). Uses busybox wget from the base image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD wget -q -O - "http://127.0.0.1:${PORT:-3000}/api/webhooks" >/dev/null 2>&1 || exit 1
CMD ["node", "server.js"]
