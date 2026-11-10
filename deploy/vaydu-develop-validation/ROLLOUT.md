# Develop rollout — concrete commands

Host: `edsadmin@87.106.64.25`. Archive validated locally (`630eacdb…`). No
deployment performed here; run these only after review.

## Windows upload

Run from the repo root on the build machine:

```powershell
scp "release/vaydu-develop-9abfd8f.tar.gz" "edsadmin@87.106.64.25:~/"
scp "deploy/vaydu-develop-validation/rollout-develop.sh" "edsadmin@87.106.64.25:~/"
```

## SSH execution

```powershell
ssh edsadmin@87.106.64.25
```

Then on the host (after reviewing the script):

```sh
chmod +x ~/rollout-develop.sh
cd ~ && ./rollout-develop.sh
```

The script discovers the Compose chain from the `movabi-develop-api` container
labels (`com.docker.compose.project.config_files` → ordered array, plus
`project` and `working_dir`), preserves overrides/secrets/mounts by reusing that
exact chain, and performs: archive/checksum validation → backup → PREREQ →
apply `ORDER.txt` in order → VERIFY → record previous image IDs → build/up.

## Human develop smoke checks (run after the script)

1. **Inspection upload/review** — driver uploads the six labelled slots; admin
   reviews/approves; private storage and ownership enforced (in scope; the
   schema ships via `20261102000000_driver_vehicle_inspection.sql`).
2. Admin policy publication / margin preview.
3. Refund webhook paths (Stripe test events).
4. Driver card top-up availability/checkout in the sandbox gate.
5. Bike/Car feed isolation with real driver tokens.
6. Cash reassignment and completion PIN end-to-end.

Africa and new commercial-policy activation remain deferred.
