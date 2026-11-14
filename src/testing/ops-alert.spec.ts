import { describe, expect, it, vi } from 'vitest';
vi.mock('../../server/services/supabase.service', () => ({ supabaseAdmin: {} }));
import { OpsAlertService, decide, intervalMs, parseRecipients } from '../../server/services/ops-alert.service';

/** Area 9a / P14 (2026-11-14): scheduled ops report + email alert; recipient from host configuration only. */
const op = (jobId: string, reason = 'payment_status_requires_review') =>
  ({ jobId, paymentStatus: 'requires_review', jobStatus: 'completed', paymentIntentId: 'pi_x', ageMinutes: 90, reason });
const report = (...ops: any[]) => ({ scannedAt: '2026-11-14T10:00:00Z', unresolved: ops,
  counts: ops.reduce((c: any, o: any) => ({ ...c, [o.reason]: (c[o.reason] || 0) + 1 }), {}) });

function harness(env: Record<string, string | undefined>, reports: Array<any | Error>, deliver = true) {
  const sent: Array<{ to: string[]; kind: string; subject: string; text: string }> = [];
  let i = 0;
  const svc = new OpsAlertService({
    env, log: () => {},
    report: async () => { const r = reports[Math.min(i++, reports.length - 1)]; if (r instanceof Error) throw r; return r; },
    send: async (to, m) => { sent.push({ to, ...m }); return deliver; },
  });
  return { svc, sent };
}
const ENV = { VAYDU_OPS_ALERTS: 'true', VAYDU_OPS_ALERT_RECIPIENTS: 'ops@example.test', VAYDU_DEPLOYMENT_ENV: 'develop' };

describe('configuration comes from the host only', () => {
  it('recipients: valid comma-separated addresses, deduplicated; anything invalid means none', () => {
    expect(parseRecipients('a@x.test, b@y.test,a@x.test')).toEqual(['a@x.test', 'b@y.test']);
    expect(parseRecipients('')).toEqual([]);
    expect(parseRecipients(undefined)).toEqual([]);
    expect(parseRecipients('a@x.test, not-an-email')).toEqual([]);
    expect(parseRecipients('a@x.test;b@y.test')).toEqual([]);
  });
  it('interval: 15 minutes by default (P14); only 1 min .. 24 h accepted', () => {
    expect(intervalMs(undefined)).toBe(900_000);
    expect(intervalMs('600000')).toBe(600_000);
    expect(intervalMs('1000')).toBe(900_000);
    expect(intervalMs('abc')).toBe(900_000);
  });
  it('the schedule starts only with VAYDU_OPS_ALERTS=true', () => {
    expect(new OpsAlertService({ env: {}, log: () => {} }).start()).toBe(false);
    const s = new OpsAlertService({ env: ENV, log: () => {} });
    expect(s.start()).toBe(true); expect(s.start()).toBe(false); s.stop();
  });
  it('no address in the source tree: the recipient is never hard-coded', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('server/services/ops-alert.service.ts', 'utf8');
    expect(src.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).toEqual([]);
  });
});

describe('alerting rule', () => {
  it('new unresolved operations: one email with job ids, reasons and counts; no personal data fields', async () => {
    const { svc, sent } = harness(ENV, [report(op('j1'), op('j2', 'authorized_stale'))]);
    expect(await svc.runOnce()).toEqual({ sent: 'unresolved', delivered: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(['ops@example.test']);
    expect(sent[0].subject).toBe('[Vaydu develop] 2 unresolved payment operation(s)');
    expect(sent[0].text).toContain('job j1: payment_status_requires_review');
    expect(sent[0].text).toContain('authorized_stale: 1');
    expect(sent[0].text).not.toMatch(/customer|email|phone|address/i);
  });
  it('the same set on the next 15-minute run is not re-sent; a change is', async () => {
    const { svc, sent } = harness(ENV, [report(op('j1')), report(op('j1')), report(op('j1'), op('j3'))]);
    await svc.runOnce(); await svc.runOnce(); await svc.runOnce();
    expect(sent.map((s) => s.kind)).toEqual(['unresolved', 'unresolved']);
    expect(sent[1].text).toContain('job j3');
  });
  it('all resolved after an alert: one "resolved" email, then silence', async () => {
    const { svc, sent } = harness(ENV, [report(op('j1')), report(), report()]);
    await svc.runOnce(); await svc.runOnce(); await svc.runOnce();
    expect(sent.map((s) => s.kind)).toEqual(['unresolved', 'resolved']);
  });
  it('nothing unresolved from the start: no email at all', async () => {
    const { svc, sent } = harness(ENV, [report(), report()]);
    await svc.runOnce(); await svc.runOnce();
    expect(sent).toHaveLength(0);
  });
  it('report failure: one alert per failure episode; recovery with the same set re-sends it', async () => {
    const { svc, sent } = harness(ENV, [report(op('j1')), new Error('db down'), new Error('db down'), report(op('j1'))]);
    for (let i = 0; i < 4; i++) await svc.runOnce();
    expect(sent.map((s) => s.kind)).toEqual(['unresolved', 'report_failed', 'unresolved']);
    expect(sent[1].text).toContain('db down');
  });
  it('failed delivery is retried on the next run (state not advanced)', async () => {
    const h = harness(ENV, [report(op('j1'))], false);
    expect(await h.svc.runOnce()).toEqual({ sent: 'unresolved', delivered: false });
    expect(await h.svc.runOnce()).toEqual({ sent: 'unresolved', delivered: false });
    expect(h.sent).toHaveLength(2);
  });
  it('no recipient configured: nothing is sent, nothing is lost (sent once configured)', async () => {
    const env = { ...ENV, VAYDU_OPS_ALERT_RECIPIENTS: '' };
    const { svc, sent } = harness(env, [report(op('j1'))]);
    expect((await svc.runOnce()).skipped).toBe('no recipients');
    expect(sent).toHaveLength(0);
    env.VAYDU_OPS_ALERT_RECIPIENTS = 'ops@example.test';
    expect(await svc.runOnce()).toEqual({ sent: 'unresolved', delivered: true });
  });
  it('overlapping runs are skipped (a slow report never runs twice at once)', async () => {
    let release: () => void = () => {};
    const svc = new OpsAlertService({ env: ENV, log: () => {}, send: async () => true,
      report: () => new Promise((r) => { release = () => r(report(op('j1')) as any); }) });
    const first = svc.runOnce();
    expect((await svc.runOnce()).skipped).toBe('previous run still in progress');
    release(); await first;
  });
  it('pure decision: unchanged set is silent', () => {
    const r = report(op('j1'));
    const first = decide({ lastFingerprint: null, failing: false }, { report: r });
    expect(first.message?.kind).toBe('unresolved');
    expect(decide(first.next, { report: r }).message).toBeNull();
  });
});
