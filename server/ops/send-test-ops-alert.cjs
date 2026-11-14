/**
 * Host check for area 9a / P14: sends ONE test email through the same sender and recipients the
 * scheduled ops alert uses (VAYDU_OPS_ALERT_RECIPIENTS + EMAIL_* in the API container). Changes no data.
 *   docker exec movabi-develop-api node server/ops/send-test-ops-alert.cjs
 * Exit codes: 0 delivered, 4 no valid recipients configured, 5 SMTP not configured or not accepted.
 */
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs', esModuleInterop: true, allowSyntheticDefaultImports: true } });
const { parseRecipients, smtpSender } = require('../services/ops-alert.service.ts');
(async () => {
  const to = parseRecipients(process.env.VAYDU_OPS_ALERT_RECIPIENTS);
  if (!to.length) { console.log('NO_RECIPIENTS: set VAYDU_OPS_ALERT_RECIPIENTS in the API configuration'); process.exitCode = 4; return; }
  let ok = false;
  try {
    ok = await smtpSender(to, { kind: 'unresolved', subject: `[Vaydu ${process.env.VAYDU_DEPLOYMENT_ENV || 'develop'}] Ops alert test`,
      text: `Test message from the scheduled payment-operations alert (area 9a). Sent ${new Date().toISOString()}. No action needed.` });
  } catch (e) { console.log('SMTP_ERROR: ' + String(e && e.message || e).slice(0, 160)); }
  console.log(ok ? `DELIVERED to ${to.length} recipient(s)` : 'NOT_DELIVERED: check EMAIL_HOST/EMAIL_USER/EMAIL_PASS');
  process.exitCode = ok ? 0 : 5;
})();
