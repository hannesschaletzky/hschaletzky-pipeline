#!/bin/sh
# Runs once on first container start (empty data directory).
# Creates the least-privilege role the application connects with:
# data access (DML) only — no DDL, no extension or role management.
# Schema changes are applied by migrations running as the owner role ($POSTGRES_USER).
set -eu

: "${APP_DB_PASSWORD:?APP_DB_PASSWORD must be set}"

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_password="$APP_DB_PASSWORD" <<'SQL'
CREATE ROLE pipeline_app LOGIN PASSWORD :'app_password';

REVOKE ALL ON DATABASE :"DBNAME" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"DBNAME" TO pipeline_app;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO pipeline_app;

-- Tables and sequences created later by migrations (as the owner) are accessible to the app role.
ALTER DEFAULT PRIVILEGES FOR ROLE :"USER" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pipeline_app;
ALTER DEFAULT PRIVILEGES FOR ROLE :"USER" IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO pipeline_app;
SQL
