FROM node:22-bookworm-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# Dev target: source bind-mounted, Vite dev server started by compose.
FROM base AS dev
CMD ["sh", "-c", "echo 'dev target expects a compose-provided command' && sleep infinity"]

FROM base AS build
COPY . .
RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter @edutimetable/shared build \
  && pnpm --filter @edutimetable/web build

FROM nginx:1.27-alpine AS prod
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
