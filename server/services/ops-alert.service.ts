import nodemailer from 'nodemailer';
import { reportUnresolvedPaymentOps, type PaymentOpsReport } from './payment-operations-report.service';

/**
 * Area 9a / P14 (2026-11-14): scheduled operations report with email alerts.
 *
 * Approved: the report runs every 15 minutes (P14). The recipient is NOT in the code or the
 * repository: it is supplied by host configuration only.
 *   VAYDU_OPS_ALERTS=true                 turns the schedule on (off when absent)
 *   VAYDU_OPS_ALERT_RECIPIENTS=a@x,b@y    comma-separated addresses (required to send)
 *   VAYDU_OPS_ALERT_INTERVAL_MS           optional; default 900000 (15 min, P14)
 *   EMAIL_HOST / EMAIL_PORT / EMAIL_SECURE / EMAIL_USER / EMAIL_PASS / EMAIL_FROM   existing SMTP settings
 *
 * Alerting rule (no new policy value): an email is sent when the set of unresolved payment operations
 * CHANGES and is not empty (a new item appears, or the reasons change), when the report cannot run
 * (once per failure episode), and once when everything is resolved again. An unchanged set is not
 * re-sent every 15 minutes. The report itself never mutates financial state. Emails carry job ids,
 * statuses, ages and reasons only: no customer or driver personal data, no provider secrets.
 */
export type AlertKind = 'unresolved' | 'resolved' | 'report_failed';
export interface OpsAlertState { lastFingerprint: string | null; failing: boolean }
export interface OpsAlertMessage { kind: AlertKind; subject: string; text: string }
export type OpsMailSender = (to: string[], message: OpsAlertMessage) => Promise<boolean>;

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
export function parseRecipients(value: string | undefined | null): string[] {
    const list = String(value || '').split(',').map((v) => v.trim()).filter(Boolean);
    return list.length > 0 && list.every((v) => EMAIL.test(v)) ? Array.from(new Set(list)) : [];
}
export function intervalMs(value: string | undefined | null): number {
    const n = Number(value);
    return Number.isInteger(n) && n >= 60_000 && n <= 86_400_000 ? n : 900_000;
}
export function fingerprint(report: PaymentOpsReport): string {
    return report.unresolved.map((o) => `${o.jobId}:${o.reason}`).sort().join('|');
}

/** Pure decision: what (if anything) to send for this run, and the next state. */
export function decide(state: OpsAlertState, outcome: { report?: PaymentOpsReport; error?: string }, env = 'develop'):
    { message: OpsAlertMessage | null; next: OpsAlertState } {
    if (outcome.error !== undefined) {
        if (state.failing) return { message: null, next: state };
        return {
            message: { kind: 'report_failed', subject: `[Vaydu ${env}] Payment operations report FAILED`,
                text: `The scheduled payment operations report could not run.\nError: ${outcome.error.slice(0, 200)}\nIt will retry on the next run.` },
            next: { ...state, failing: true },
        };
    }
    const report = outcome.report!;
    const fp = fingerprint(report);
    const next: OpsAlertState = { lastFingerprint: fp, failing: false };
    if (fp === '' ) {
        const wasAlerting = !!state.lastFingerprint;
        return { message: wasAlerting ? { kind: 'resolved', subject: `[Vaydu ${env}] Payment operations: all resolved`,
            text: `No unresolved payment operations at ${report.scannedAt}.` } : null, next };
    }
    if (fp === state.lastFingerprint && !state.failing) return { message: null, next };
    const lines = report.unresolved.slice(0, 50).map((o) =>
        `- job ${o.jobId}: ${o.reason} (payment ${o.paymentStatus}, job ${o.jobStatus}, ${o.ageMinutes} min)`);
    const counts = Object.entries(report.counts).map(([k, v]) => `${k}: ${v}`).join(', ');
    return {
        message: { kind: 'unresolved', subject: `[Vaydu ${env}] ${report.unresolved.length} unresolved payment operation(s)`,
            text: [`Scanned at ${report.scannedAt}.`, `Counts: ${counts}`, '', ...lines,
                report.unresolved.length > 50 ? `... and ${report.unresolved.length - 50} more` : '',
                '', 'Review them in the admin app. This report never refunds, retries or charges anything.'].filter((l) => l !== null).join('\n') },
        next,
    };
}

export const smtpSender: OpsMailSender = async (to, message) => {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) return false;
    const transport = nodemailer.createTransport({
        host: process.env.EMAIL_HOST || 'smtp.gmail.com', port: parseInt(process.env.EMAIL_PORT || '587'),
        secure: process.env.EMAIL_SECURE === 'true', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
        connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
    });
    const info = await transport.sendMail({ from: `"Vaydu Ops" <${process.env.EMAIL_FROM || process.env.EMAIL_USER}>`, to,
        subject: message.subject.replace(/[\r\n]/g, ' ').slice(0, 180), text: message.text });
    return Array.isArray(info.accepted) && info.accepted.length > 0;
};

export class OpsAlertService {
    private state: OpsAlertState = { lastFingerprint: null, failing: false };
    private running = false;
    private timer: ReturnType<typeof setInterval> | null = null;

    constructor(private readonly deps: {
        env?: Record<string, string | undefined>;
        report?: () => Promise<PaymentOpsReport>;
        send?: OpsMailSender;
        log?: (line: string) => void;
    } = {}) {}

    private get env() { return this.deps.env ?? process.env; }
    private log(line: string) { (this.deps.log ?? ((l) => console.log(l)))(line); }

    /** One run. Returns what was sent (for tests and logs). Never throws. */
    async runOnce(): Promise<{ sent: AlertKind | null; delivered: boolean; skipped?: string }> {
        if (this.running) return { sent: null, delivered: false, skipped: 'previous run still in progress' };
        this.running = true;
        try {
            const recipients = parseRecipients(this.env.VAYDU_OPS_ALERT_RECIPIENTS);
            let outcome: { report?: PaymentOpsReport; error?: string };
            try { outcome = { report: await (this.deps.report ?? reportUnresolvedPaymentOps)() }; }
            catch (e) { outcome = { error: String((e as Error)?.message || 'unknown error') }; }
            const { message, next } = decide(this.state, outcome, this.env.VAYDU_DEPLOYMENT_ENV || 'develop');
            if (!message) { this.state = next; return { sent: null, delivered: false }; }
            if (recipients.length === 0) {
                this.log(`[OpsAlert] ${message.kind}: no valid VAYDU_OPS_ALERT_RECIPIENTS configured; not sent`);
                return { sent: null, delivered: false, skipped: 'no recipients' };   // state kept: retried next run
            }
            let delivered = false;
            try { delivered = await (this.deps.send ?? smtpSender)(recipients, message); } catch { delivered = false; }
            if (delivered) this.state = next;   // a failed delivery is retried on the next run
            this.log(`[OpsAlert] ${message.kind} ${delivered ? 'delivered' : 'NOT delivered (will retry)'} to ${recipients.length} recipient(s)`);
            return { sent: message.kind, delivered };
        } finally { this.running = false; }
    }

    /** Starts the schedule when VAYDU_OPS_ALERTS=true. Returns whether it started. */
    start(): boolean {
        if (this.env.VAYDU_OPS_ALERTS !== 'true' || this.timer) return false;
        const every = intervalMs(this.env.VAYDU_OPS_ALERT_INTERVAL_MS);
        this.timer = setInterval(() => { void this.runOnce(); }, every);
        (this.timer as any).unref?.();
        this.log(`[OpsAlert] schedule on: every ${Math.round(every / 60000)} min, recipients ${parseRecipients(this.env.VAYDU_OPS_ALERT_RECIPIENTS).length}`);
        return true;
    }
    stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
