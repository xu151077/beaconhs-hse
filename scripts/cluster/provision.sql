-- BeaconHS database provisioning (run as a PostgreSQL superuser).
--
-- Usage:
--   psql "postgresql://postgres:***@localhost:5432/postgres" \
--     -v app_password='CHANGE_ME_APP' \
--     -v super_password='CHANGE_ME_SUPER' \
--     -v migrator_password='CHANGE_ME_MIGRATOR' \
--     -v backup_password='CHANGE_ME_BACKUP' \
--     -v audit_service_password='CHANGE_ME_AUDIT' \
--     -f scripts/cluster/provision.sql
--
-- Role model:
--   beaconhs_owner     NOLOGIN owner of database/schema/application objects
--   beaconhs_migrator  LOGIN; can SET ROLE beaconhs_owner; never used by app
--   beaconhs_app       LOGIN; tenant-scoped runtime DML; no ownership/bypass
--   beaconhs_super     LOGIN; cross-tenant DML with BYPASSRLS; no ownership
--   beaconhs_backup    LOGIN; read-only logical backup with BYPASSRLS
--   audit_reader       NOLOGIN; cross-tenant audit_log reads via BYPASSRLS (PD-02)
--   audit_service      LOGIN; the only member of audit_reader; AUDIT_DATABASE_URL identity

\set ON_ERROR_STOP on

SELECT 'CREATE ROLE beaconhs_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'beaconhs_owner')
\gexec
ALTER ROLE beaconhs_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

SELECT format(
  'CREATE ROLE beaconhs_migrator LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'migrator_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'beaconhs_migrator')
\gexec
ALTER ROLE beaconhs_migrator LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
SELECT format('ALTER ROLE beaconhs_migrator PASSWORD %L', :'migrator_password') \gexec

SELECT format(
  'CREATE ROLE beaconhs_app LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'app_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'beaconhs_app')
\gexec
ALTER ROLE beaconhs_app LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
SELECT format('ALTER ROLE beaconhs_app PASSWORD %L', :'app_password') \gexec

SELECT format(
  'CREATE ROLE beaconhs_super LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD %L',
  :'super_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'beaconhs_super')
\gexec
ALTER ROLE beaconhs_super LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
SELECT format('ALTER ROLE beaconhs_super PASSWORD %L', :'super_password') \gexec

SELECT format(
  'CREATE ROLE beaconhs_backup LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD %L',
  :'backup_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'beaconhs_backup')
\gexec
ALTER ROLE beaconhs_backup LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
SELECT format('ALTER ROLE beaconhs_backup PASSWORD %L', :'backup_password') \gexec

-- PD-02 audit roles. audit_reader is the ONLY cross-tenant audit identity in the
-- system: NOLOGIN so it can never be a connection identity, BYPASSRLS so it can
-- read audit_log regardless of tenant context, and granted exclusively to
-- audit_service (the AUDIT_DATABASE_URL login). No other role may hold it.
SELECT 'CREATE ROLE audit_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_reader')
\gexec
ALTER ROLE audit_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;

SELECT format(
  'CREATE ROLE audit_service LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'audit_service_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_service')
\gexec
ALTER ROLE audit_service LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
SELECT format('ALTER ROLE audit_service PASSWORD %L', :'audit_service_password') \gexec

-- The migrator must opt into ownership explicitly. Runtime roles must never be
-- owner members; remove the old super -> app membership during upgrades.
SELECT 'GRANT beaconhs_owner TO beaconhs_migrator'
WHERE NOT pg_has_role('beaconhs_migrator', 'beaconhs_owner', 'MEMBER')
\gexec
SELECT format('REVOKE %I FROM %I', parent.rolname, member.rolname)
FROM pg_auth_members membership
JOIN pg_roles parent ON parent.oid = membership.roleid
JOIN pg_roles member ON member.oid = membership.member
WHERE (
    parent.rolname = 'beaconhs_owner'
    AND member.rolname IN ('beaconhs_app', 'beaconhs_super', 'beaconhs_backup', 'audit_service')
  )
   OR (
    parent.rolname = 'audit_reader'
    AND member.rolname <> 'audit_service'
  )
   OR (
    parent.rolname = 'audit_service'
    AND member.rolname <> 'audit_reader'
  )
   OR (
      parent.rolname = 'beaconhs_app'
      AND member.rolname IN ('beaconhs_super', 'beaconhs_backup')
    )
\gexec

-- audit_service is the sole member of audit_reader. The REVOKE loop above
-- strips any other membership that may have been granted out of band.
SELECT 'GRANT audit_reader TO audit_service'
WHERE NOT pg_has_role('audit_service', 'audit_reader', 'MEMBER')
\gexec

SELECT 'CREATE DATABASE beaconhs OWNER beaconhs_owner'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'beaconhs')
\gexec
ALTER DATABASE beaconhs OWNER TO beaconhs_owner;
ALTER DATABASE beaconhs SET timezone TO 'UTC';

REVOKE ALL PRIVILEGES ON DATABASE beaconhs FROM PUBLIC;
GRANT CONNECT ON DATABASE beaconhs TO beaconhs_migrator, beaconhs_app, beaconhs_super, beaconhs_backup, audit_service;

\connect beaconhs

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Existing installations used beaconhs_app as owner. Transfer every object in
-- this database before reducing the app login to DML-only privileges.
REASSIGN OWNED BY beaconhs_app TO beaconhs_owner;
ALTER SCHEMA public OWNER TO beaconhs_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC, beaconhs_app, beaconhs_super;
GRANT USAGE ON SCHEMA public TO beaconhs_app, beaconhs_super, beaconhs_backup;
-- audit_reader needs schema USAGE to reach audit_log after SET ROLE, and
-- audit_service needs it for grant/trail reads as its base login (before the
-- SET LOCAL ROLE switch). Neither gains object privileges from USAGE.
GRANT USAGE ON SCHEMA public TO audit_reader, audit_service;

-- Private ETL bookkeeping is intentionally isolated from runtime traffic. The
-- BYPASSRLS maintenance login may create and maintain only this schema.
CREATE SCHEMA IF NOT EXISTS etl AUTHORIZATION beaconhs_owner;
ALTER SCHEMA etl OWNER TO beaconhs_owner;
REVOKE ALL ON SCHEMA etl FROM PUBLIC, beaconhs_app;
GRANT USAGE, CREATE ON SCHEMA etl TO beaconhs_super;
GRANT USAGE ON SCHEMA etl TO beaconhs_backup;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM beaconhs_app, beaconhs_super;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO beaconhs_app, beaconhs_super;
-- PD-02: the two platform audit tables are owner + audit_service only. The
-- blanket grants above must never reach them, and beaconhs_super must not read
-- the cross-tenant audit trail (audit_log) on the business pool — audit_reader
-- is the only cross-tenant audit identity. super keeps INSERT on audit_log
-- (platform actions append trail entries); it loses SELECT. converge_audit
-- privileges in the migrator re-enforce this on every run.
SELECT 'REVOKE ALL PRIVILEGES ON audit_access_grants FROM beaconhs_app, beaconhs_super'
WHERE to_regclass('public.audit_access_grants') IS NOT NULL
\gexec
SELECT 'REVOKE ALL PRIVILEGES ON platform_audit_access_log FROM beaconhs_app, beaconhs_super'
WHERE to_regclass('public.platform_audit_access_log') IS NOT NULL
\gexec
SELECT 'REVOKE SELECT ON audit_log FROM beaconhs_super'
WHERE to_regclass('public.audit_log') IS NOT NULL
\gexec
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM beaconhs_app, beaconhs_super;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO beaconhs_app, beaconhs_super;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO beaconhs_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO beaconhs_backup;

-- audit_reader reads exactly one table: audit_log. The grant is guarded because
-- audit_log only exists after the first migration run; re-running provision.sql
-- after migrations converges the privilege. Everything else stays denied.
SELECT 'REVOKE ALL PRIVILEGES ON audit_log FROM audit_reader'
WHERE to_regclass('public.audit_log') IS NOT NULL
\gexec
SELECT 'GRANT SELECT ON audit_log TO audit_reader'
WHERE to_regclass('public.audit_log') IS NOT NULL
\gexec

-- The migration tracker schema exists only after the first migration run.
SELECT 'GRANT USAGE ON SCHEMA drizzle TO beaconhs_backup'
WHERE to_regnamespace('drizzle') IS NOT NULL
\gexec
SELECT 'GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO beaconhs_backup'
WHERE to_regnamespace('drizzle') IS NOT NULL
\gexec
SELECT 'GRANT SELECT ON ALL SEQUENCES IN SCHEMA drizzle TO beaconhs_backup'
WHERE to_regnamespace('drizzle') IS NOT NULL
\gexec

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA etl TO beaconhs_super;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA etl TO beaconhs_super;
GRANT SELECT ON ALL TABLES IN SCHEMA etl TO beaconhs_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA etl TO beaconhs_backup;

ALTER DEFAULT PRIVILEGES FOR ROLE beaconhs_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO beaconhs_app, beaconhs_super;
ALTER DEFAULT PRIVILEGES FOR ROLE beaconhs_owner IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO beaconhs_app, beaconhs_super;
ALTER DEFAULT PRIVILEGES FOR ROLE beaconhs_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO beaconhs_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE beaconhs_owner IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO beaconhs_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE beaconhs_owner IN SCHEMA etl
  GRANT ALL PRIVILEGES ON TABLES TO beaconhs_super;
ALTER DEFAULT PRIVILEGES FOR ROLE beaconhs_owner IN SCHEMA etl
  GRANT ALL PRIVILEGES ON SEQUENCES TO beaconhs_super;
ALTER DEFAULT PRIVILEGES FOR ROLE beaconhs_super IN SCHEMA etl
  GRANT ALL PRIVILEGES ON TABLES TO beaconhs_super;
ALTER DEFAULT PRIVILEGES FOR ROLE beaconhs_super IN SCHEMA etl
  GRANT ALL PRIVILEGES ON SEQUENCES TO beaconhs_super;
ALTER DEFAULT PRIVILEGES FOR ROLE beaconhs_owner IN SCHEMA etl
  GRANT SELECT ON TABLES TO beaconhs_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE beaconhs_owner IN SCHEMA etl
  GRANT SELECT ON SEQUENCES TO beaconhs_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE beaconhs_super IN SCHEMA etl
  GRANT SELECT ON TABLES TO beaconhs_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE beaconhs_super IN SCHEMA etl
  GRANT SELECT ON SEQUENCES TO beaconhs_backup;

-- Connection hygiene applies equally to the login roles.
ALTER ROLE beaconhs_migrator SET idle_in_transaction_session_timeout = '5min';
ALTER ROLE beaconhs_app SET idle_in_transaction_session_timeout = '5min';
ALTER ROLE beaconhs_super SET idle_in_transaction_session_timeout = '5min';
ALTER ROLE beaconhs_backup SET default_transaction_read_only = 'on';
ALTER ROLE beaconhs_backup SET idle_in_transaction_session_timeout = '5min';
ALTER ROLE audit_service SET idle_in_transaction_session_timeout = '5min';
ALTER ROLE audit_service SET statement_timeout = '10s';
ALTER ROLE beaconhs_migrator SET tcp_keepalives_idle = '60';
ALTER ROLE beaconhs_app SET tcp_keepalives_idle = '60';
ALTER ROLE beaconhs_super SET tcp_keepalives_idle = '60';
ALTER ROLE beaconhs_backup SET tcp_keepalives_idle = '60';
ALTER ROLE audit_service SET tcp_keepalives_idle = '60';
ALTER ROLE beaconhs_migrator SET tcp_keepalives_interval = '10';
ALTER ROLE beaconhs_app SET tcp_keepalives_interval = '10';
ALTER ROLE beaconhs_super SET tcp_keepalives_interval = '10';
ALTER ROLE beaconhs_backup SET tcp_keepalives_interval = '10';
ALTER ROLE audit_service SET tcp_keepalives_interval = '10';
ALTER ROLE beaconhs_migrator SET tcp_keepalives_count = '6';
ALTER ROLE beaconhs_app SET tcp_keepalives_count = '6';
ALTER ROLE beaconhs_super SET tcp_keepalives_count = '6';
ALTER ROLE beaconhs_backup SET tcp_keepalives_count = '6';
ALTER ROLE audit_service SET tcp_keepalives_count = '6';
