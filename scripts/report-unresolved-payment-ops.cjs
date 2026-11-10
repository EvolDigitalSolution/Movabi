/**
 * Read-only operator execution path for unresolved/aged payment ops.
 * Uses the existing payment-operations-report service; never mutates state,
 * retries, refunds or charges. Run from an existing scheduler/cron:
 *   node scripts/report-unresolved-payment-ops.cjs
 * Exit codes: 0 clean, 2 unresolved ops present, 3 query failure.
 */
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs', esModuleInterop: true, allowSyntheticDefaultImports: true } });
const { reportUnresolvedPaymentOps } = require('../server/services/payment-operations-report.service.ts');

(async () => {
  try {
    const out = await reportUnresolvedPaymentOps();
    console.log(JSON.stringify(out, null, 1));
    if (out.unresolved.length > 0) process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({ error: 'query_failed', detail: String(error?.message || '').slice(0, 200) }));
    process.exitCode = 3;
  }
})();
