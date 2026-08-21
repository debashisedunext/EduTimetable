# EduTimetable

AI-powered school timetable system for the Edunext ERP. Spec: `AI-Timetable-System-Architecture.md` · Plan: `IMPLEMENTATION-PLAN.md` · Working rules: `CLAUDE.md`.

## Run (Docker only)

The only supported way to run anything is the Docker Compose stack — no Node, MySQL, or Redis on the host.

```bash
cp .env.example .env    # once
docker compose up       # dev stack: api host :3001, web host :5174, worker, mysql, redis
```

Open http://localhost:5174 → "Simulate ERP login" (dev stand-in for the Edunext ERP → Timetable menu SSO hand-off) → pick a persona (Super Admin / Principal / Teacher / Front Office) to see role-gated navigation.

Common commands (always inside containers):

```bash
docker compose exec api pnpm test                      # unit tests
docker compose exec api pnpm exec prisma migrate dev   # create a migration
docker compose exec api pnpm lint                      # lint
```

Production images: `docker compose -f docker-compose.yml up` (dev overrides live in `docker-compose.override.yml`, auto-loaded by plain `docker compose up`).

## Layout

- `apps/api` — NestJS API + BullMQ worker (`src/worker.ts`), Prisma/MySQL, Socket.IO, ERP SSO (§15)
- `apps/web` — React + Vite + Tailwind app shell (design tokens from `timetable-ui-mockup.html`)
- `packages/shared` — permission registry, SSO/session/scope types shared by both
- `docker/` — Dockerfiles + nginx config
