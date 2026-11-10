# Develop-host commands (reviewed; run interactively after upload)

Host: `edsadmin@87.106.64.25`. DB container is discovered from the API container
labels (typically `movabi-supabase-db`, database `movabi_develop`); API
`movabi-api` or `movabi-develop-api`; web/admin `movabi-admin`. The live Compose
file chain is discovered from the running container label â€” do not guess it.

The frozen release is `vaydu-develop-35b2590` (source SHA `35b259097c9c6a07940695d37bc4a70b6c7b2ea0`).
It packages a 39-step migration manifest plus the built mobile, admin and API.

## Upload (from the repo root on the build machine)

```powershell
scp "release/vaydu-develop-35b2590.tar.gz" "edsadmin@87.106.64.25:~/"
scp "deploy/vaydu-develop-validation/rollout-develop.sh" "edsadmin@87.106.64.25:~/"
```

## Execute (on the host, after reviewing the script)

```sh
ssh edsadmin@87.106.64.25
cd ~
chmod +x rollout-develop.sh
# If the API container is not auto-detected, pass it explicitly:
#   API_CONTAINER=movabi-api ./rollout-develop.sh
./rollout-develop.sh
```

The script: resolves the API container â†’ discovers the Compose project /
working-dir / config_files chain from its labels â†’ validates the archive and
ALL_SHA256SUMS/SHA256SUMS â†’ takes and verifies a `pg_dump` backup â†’ applies
`PREREQ.sql` â†’ applies `ORDER.txt` (39 steps, stop-on-failure) â†’ `VERIFY.sql` â†’
records previous image IDs â†’ `docker compose build` from the extracted bundle â†’
`docker compose up -d`.

## Post-rollout smoke (on the host)

```sh
docker exec movabi-api node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
```

## Recovery â€” three separate cases

### A. Pre-traffic migration failure (no new traffic yet)

- Each migration is transactional; a failure aborts only that step. Earlier
  steps remain committed. Do **not** restore the backup if no post-migration
  writes occurred.
- Fix the failing step, re-run from that step; re-running an applied step is
  guarded by its own idempotency checks and will fail closed on divergence.

### B. Application rollback (traffic already on the new schema)

- Rolling the API/web back does **not** require a database restore. The manifest
  is additive; old code ignores new tables/functions.
- Preserve new financial rows: never delete holds, routes or wallet events.
- Re-deploy the previous image tag with the same Compose chain, keep the schema.

### C. Database restore (disaster or isolated drill only)

- Restore is **never** an automatic rollback. A restore erases legitimate
  post-deployment financial activity if used after go-live.
- Drill only against an isolated clone: `createdb movabi_drill`,
  `pg_restore -d movabi_drill develop-before-$STAMP.dump`, verify counts, then drop.
