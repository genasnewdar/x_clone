#!/bin/sh
# Runs once, on first start of an empty data volume.
# The app connects as agentx_app, which owns the agentx database (so it can
# run migrations) but is NOT a superuser: it cannot read other databases,
# create roles, load extensions, or run COPY ... PROGRAM.
# The password is passed as a psql variable and quoted with :'pw', so a
# password containing quotes cannot break (or inject into) the SQL.
set -eu
psql -v ON_ERROR_STOP=1 -v pw="$APP_DB_PASSWORD" --username postgres --dbname agentx <<'SQL'
CREATE ROLE agentx_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'pw';
ALTER DATABASE agentx OWNER TO agentx_app;
ALTER SCHEMA public OWNER TO agentx_app;
REVOKE ALL ON DATABASE agentx FROM PUBLIC;
GRANT CONNECT ON DATABASE agentx TO agentx_app;
SQL
