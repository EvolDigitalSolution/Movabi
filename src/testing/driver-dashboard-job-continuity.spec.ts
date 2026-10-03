/**
 * DRIVER DASHBOARD / JOB CONTINUITY / NAVIGATION UX.
 *
 * Source-assertion guard for the bounded frontend fixes:
 *   - Accept is hoisted above the map/secondary sections and is single-source;
 *   - double-submit is guarded;
 *   - navigation is context-sensitive and reuses the existing deep-link helper;
 *   - the dashboard scroll/occlusion floor is removed and cards stay clickable;
 *   - the empty state only appears when there genuinely are no jobs.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';

const read = (p: string) => readFileSync(pathResolve(process.cwd(), p), 'utf8');
const DASH = read('src/app/apps/mobile/features/driver/dashboard/dashboard.page.ts');
const JD = read('src/app/apps/mobile/features/driver/job-details/job-details.page.ts');

const count = (src: string, needle: string) => src.split(needle).length - 1;
const lineOf = (src: string, needle: string) => {
  const i = src.indexOf(needle);
  return i === -1 ? -1 : src.slice(0, i).split('\n').length;
};

describe('Accept action is hoisted and single-source', () => {
  it('renders the accept control before the map/navigation section', () => {
    const acceptLine = lineOf(JD, 'Accept This Request');
    const mapLine = lineOf(JD, '<app-card class="overflow-hidden">');
    expect(acceptLine).toBeGreaterThan(0);
    expect(mapLine).toBeGreaterThan(0);
    expect(acceptLine).toBeLessThan(mapLine);
  });

  it('has exactly ONE live accept control', () => {
    expect(count(JD, '(clicked)="confirmAssignedJob()"')).toBe(1);
    expect(count(JD, 'Accept This Request')).toBe(1);
  });

  it('guards against double submission', () => {
    expect(JD).toContain('confirmingAssignment = signal(false);');
    expect(JD).toContain('if (this.confirmingAssignment()) return;');
    expect(JD).toContain('this.confirmingAssignment.set(false);');
    expect(JD).toContain('[loading]="confirmingAssignment()"');
  });
});

describe('Context-sensitive navigation', () => {
  it('derives the target and label from the current lifecycle stage', () => {
    expect(JD).toContain('navigationTargetAddress()');
    expect(JD).toContain('navigateButtonLabel()');
    expect(JD).toContain('isHeadingToCustomer()');
    expect(JD).toContain('Navigate to ${this.destinationActionLabel()}');
    expect(JD).toContain('Navigate to ${this.originActionLabel()}');
  });

  it('reuses the existing deep-link helper (no new navigation subsystem)', () => {
    expect(JD).toContain('(click)="openMap(navigationTargetAddress())"');
    expect(JD).toContain("window.open(`https://www.google.com/maps/search/?api=1&query=");
  });
});

describe('Dashboard interaction hierarchy', () => {
  it('removes the hard min-height occlusion floor', () => {
    expect(DASH).not.toContain('min-h-[560px]');
    expect(DASH).toContain('100dvh');
  });

  it('active job card is clickable and keyboard accessible', () => {
    expect(DASH).toContain('(click)="resumeActiveJob()"');
    expect(DASH).toContain('role="button"');
    expect(DASH).toContain('tabindex="0"');
    expect(DASH).toContain('Continue Job');
  });

  it('available jobs are rendered as clickable cards', () => {
    expect(DASH).toContain('(click)="selectJob(job.id)"');
    expect(DASH).toContain('Available Requests');
  });

  it('empty state only fires when there are genuinely no eligible jobs', () => {
    expect(DASH).toContain("jobs().length === 0");
    expect(DASH).toContain('No requests right now');
  });
});

describe('Back to Available Requests control', () => {
  it('is exposed on the selected available request', () => {
    expect(DASH).toContain('(click)="showAvailableRequests()"');
    expect(DASH).toContain('Back to Available Requests');
  });

  it('clears ONLY the local selection - no reject/pass, no RPC, no status change', () => {
    const start = DASH.indexOf('showAvailableRequests(): void {');
    expect(start).toBeGreaterThan(-1);
    const body = DASH.slice(start, DASH.indexOf('}', start));
    expect(body).toContain('this.selectedJobId.set(null);');
    expect(body).not.toMatch(/\breject\b|\bpass\b|\brpc\b|\baccept\b|\bstatus\b|\bdelete\b|\brefetch\b/i);
  });

  it('leaves the Pass action as the only rejection path', () => {
    expect(DASH).toContain('(click)="reject(selectedJob!.id)"');
  });

  it('keeps the available list rendered and independently clickable after Back', () => {
    expect(DASH).toContain('(click)="selectJob(job.id)"');
    expect(DASH).toContain("jobs().length === 0");
  });
});
