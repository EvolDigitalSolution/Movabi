# Recovery between API deployment and activation

The verified baseline is API f949a14 and web movabi-web:release-f949a14-linux. The operator
tools hash every served web file against the pinned f949a14 bundle and compare the exact file
inventory before accepting that baseline. An unexpected tag, image-ID/tag mismatch, altered,
missing or extra file stops rollout. No web build/recreation is performed.

The paired API is exactly the previously reviewed eef726b archive, reused byte for byte. Its
only source changes from f949a14 are server/routes/global-ai-pricing.routes.ts,
server/routes/payment.routes.ts and server/services/gb-quote-tenant.ts. SOURCE_SHA, checksum
manifests and API patch provenance metadata are the only other archive differences. Packaging
asserts this complete difference set; P8_API_DIFF.json records it. Web, calculators and release
SQL remain byte-identical to f949a14. This tooling correction adds no API or SQL behaviour.

The deployment prints P8_API_EVIDENCE=/home/edsadmin/vaydu-p8-api.<suffix>. Keep that directory:
it contains the original API image ID/tag/source, a recovery pin tag retaining the old image,
the original compose chain/project/directory, and the exact web image ID/tag/container ID.
The web is verified again after API rollout, and those three identities must remain equal.
Keep the existing passing restore evidence; no new backup or drill is required.

If API deployment succeeds but the activation transaction fails, ON_ERROR_STOP and the single
outer transaction roll back the strategy, optional legacy-country, setting, campaign, policy
and tenant-binding changes together. Retain the paired API while diagnosing: its native-tenant
switch stays off until that transaction commits. Rerun inspection, then --apply when the actual
reported conflict is resolved. Do not rerun database migrations or restore a backup for this.

For an explicit API rollback **only when activation has not committed**, run:

```bash
# F is the extracted corrected tooling root; E is the printed API deployment evidence path.
bash "$F/recover-p8-api.sh" "$E"
```

The recovery script queries the database first and refuses if any GB quote-tenant binding is
enabled, including an uncertain commit outcome. Otherwise it restores the recorded exact API
image ID using the recorded develop compose chain and an explicit final image override, with
--no-build --no-deps api. It verifies f949a14 source, exact API image, unchanged web image and
container IDs, f949a14 web content, and health. It neither changes SQL nor rebuilds web. Missing
images/configuration or identity drift fail rather than falling back to a guessed tag. Review
any later operational compose changes before running recovery; preserve unrelated operator work.

If activation committed but the **post-commit quote checks** failed, SQL is already committed.
Do not treat that as an automatic rollback, do not deploy the old API, and do not revert
financial data or campaign history. Keep the paired API, evidence, apply.log, quotes-before/
after logs and current state. Investigate the failed assertion and make a separately reviewed
scoped correction. The recovery guard blocks reverting the API while the binding is active.
