-- Graphite Postgres bootstrap: schemas and roles.
-- Runs once on first container init (docker-entrypoint-initdb.d).

-- Dataset tables live in their own schema, separate from app tables.
CREATE SCHEMA IF NOT EXISTS datasets;

-- App role: read/write on public, create/write inside the datasets schema.
CREATE ROLE graphite_app LOGIN PASSWORD 'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE graphite TO graphite_app;
GRANT USAGE, CREATE ON SCHEMA public TO graphite_app;
GRANT USAGE, CREATE ON SCHEMA datasets TO graphite_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO graphite_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO graphite_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA datasets GRANT ALL ON TABLES TO graphite_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA datasets GRANT ALL ON SEQUENCES TO graphite_app;

-- Read-only role for user-visible SQL: SELECT on the datasets schema only.
CREATE ROLE graphite_readonly LOGIN PASSWORD 'readonly_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE graphite TO graphite_readonly;
GRANT USAGE ON SCHEMA datasets TO graphite_readonly;
-- statement_timeout enforced at role level; the data service caps it further per query.
ALTER ROLE graphite_readonly SET statement_timeout = '10s';
-- Bare table names in user SQL resolve against the datasets schema only.
ALTER ROLE graphite_readonly SET search_path = datasets;

-- The admin user (graphite) owns migrations; app tables created by it must be
-- readable/writable by graphite_app. Default privileges above only apply to
-- objects created by graphite_app itself, so also grant on admin-created tables.
ALTER DEFAULT PRIVILEGES FOR ROLE graphite IN SCHEMA public GRANT ALL ON TABLES TO graphite_app;
ALTER DEFAULT PRIVILEGES FOR ROLE graphite IN SCHEMA public GRANT ALL ON SEQUENCES TO graphite_app;
