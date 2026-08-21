# Multi-stage image shared by the `api` and `worker` services.
FROM node:22-bookworm-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

# Dev target: source is bind-mounted by compose; command comes from the override file.
FROM base AS dev
CMD ["sh", "-c", "echo 'dev target expects a compose-provided command' && sleep infinity"]

FROM base AS build
COPY . .
RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter @edutimetable/shared build \
  && pnpm --filter @edutimetable/api exec prisma generate \
  && pnpm --filter @edutimetable/api build

FROM base AS prod
ENV NODE_ENV=production
COPY --from=build /app /app
CMD ["node", "apps/api/dist/main.js"]
