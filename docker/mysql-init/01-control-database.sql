-- Phase 9.2 (§17.3) — the control-plane database.
--
-- The tenant registry lives in its own schema because a dedicated tenant's
-- connection details cannot be stored inside a tenant database (you need the
-- registry to find that database), and because Prisma cannot host two migration
-- histories in one schema.
--
-- It is the same MySQL server and the same credentials, so a single-school
-- install still needs no extra container and no operator action — this runs
-- automatically on first start of the `mysql` volume.
CREATE DATABASE IF NOT EXISTS `edutimetable_control`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
