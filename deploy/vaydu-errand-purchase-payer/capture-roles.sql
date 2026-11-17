-- capture-roles.sql — read-only. Run on the develop host against movabi_develop:
--   docker exec -i movabi-develop-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" \
--     psql -X -U supabase_admin -d movabi_develop -v ON_ERROR_STOP=1 -P pager=off -qAt -F"|"' \
--     < capture-roles.sql > roles.sql
--
-- Emits guarded CREATE ROLE / GRANT statements (NO passwords) that the
-- disposable rehearsal instance applies BEFORE pg_restore, so every OWNER TO /
-- GRANT TO in the dump resolves. Each statement is an existence-guarded DO
-- block: an already-present bootstrap role (postgres, supabase_admin, etc.)
-- is skipped cleanly; any OTHER error remains fatal.
-- The trailing '-- role: <name>' / '-- grant: <a>-><b>' markers let the
-- rehearsal build the legitimate-owner allowlist for its verification step.

SELECT format(
  'DO $mk$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=%L) '
  'THEN CREATE ROLE %I WITH %s; END IF; END $mk$; -- role: %s',
  rolname, rolname,
  concat_ws(' ',
    CASE WHEN rolsuper       THEN 'SUPERUSER'      ELSE 'NOSUPERUSER'      END,
    CASE WHEN rolinherit     THEN 'INHERIT'        ELSE 'NOINHERIT'        END,
    CASE WHEN rolcreaterole  THEN 'CREATEROLE'     ELSE 'NOCREATEROLE'     END,
    CASE WHEN rolcreatedb    THEN 'CREATEDB'       ELSE 'NOCREATEDB'       END,
    CASE WHEN rolcanlogin    THEN 'LOGIN'          ELSE 'NOLOGIN'          END,
    CASE WHEN rolreplication THEN 'REPLICATION'    ELSE 'NOREPLICATION'    END,
    CASE WHEN rolbypassrls   THEN 'BYPASSRLS'      ELSE 'NOBYPASSRLS'      END,
    'CONNECTION LIMIT '||rolconnlimit),
  rolname)
FROM pg_roles
WHERE rolname !~ '^pg_'
  AND rolname NOT IN ('postgres')
ORDER BY rolname;

SELECT format(
  'DO $mk$ BEGIN IF NOT EXISTS ('
  'SELECT 1 FROM pg_auth_members am JOIN pg_roles r ON r.oid=am.roleid '
  'JOIN pg_roles m ON m.oid=am.member WHERE r.rolname=%L AND m.rolname=%L) '
  'THEN GRANT %I TO %I%s; END IF; END $mk$; -- grant: %s->%s',
  r.rolname, m.rolname, r.rolname, m.rolname,
  CASE WHEN am.admin_option THEN ' WITH ADMIN OPTION' ELSE '' END,
  r.rolname, m.rolname)
FROM pg_auth_members am
JOIN pg_roles r ON r.oid = am.roleid
JOIN pg_roles m ON m.oid = am.member
WHERE r.rolname !~ '^pg_' AND m.rolname !~ '^pg_'
ORDER BY r.rolname, m.rolname;
