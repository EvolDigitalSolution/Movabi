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

  it('renders the Navigate button above the embedded map', () => {
    expect(lineOf(JD, '{{ navigateButtonLabel() }}')).toBeLessThan(lineOf(JD, '<app-map #pickupMap>'));
  });

  it('uses turn-by-turn directions (maps/dir), not a search (maps/search)', () => {
    expect(JD).toContain('https://www.google.com/maps/dir/?api=1&destination=');
    expect(JD).not.toContain('maps/search');
  });

  it('prefers validated pickup/dropoff coordinates over the address', () => {
    expect(JD).toContain('const lat = heading ? job?.dropoff_lat : job?.pickup_lat;');
    expect(JD).toContain('const lng = heading ? job?.dropoff_lng : job?.pickup_lng;');
    expect(JD).toContain('safeAddress ? encodeURIComponent(safeAddress)');
  });

  it('never treats 0,0 as a legitimate destination', () => {
    expect(JD).toContain('this.isValidCoordinate(lat)');
    expect(JD).toContain('Math.abs(value) > 0.000001');
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

describe('Stage-aware navigation copy', () => {
  it('errand: Store navigation before collection, Customer navigation after', () => {
    expect(JD).toContain("return heading ? 'Customer navigation' : 'Store navigation';");
  });

  it('ride: Pickup navigation before, Destination navigation after', () => {
    expect(JD).toContain("return heading ? 'Destination navigation' : 'Pickup navigation';");
  });

  it('delivery: Collection before, Recipient after', () => {
    expect(JD).toContain("return heading ? 'Recipient navigation' : 'Collection navigation';");
  });

  it('van-moving: Move pickup before, Move destination after', () => {
    expect(JD).toContain("return heading ? 'Move destination navigation' : 'Move pickup navigation';");
  });

  it('terminal jobs hide the Navigate action and return no destination', () => {
    expect(JD).toContain('isNavigationTerminal(): boolean');
    expect(JD).toContain("'delivered', 'completed', 'cancelled', 'canceled', 'failed'");
    expect(JD).toContain('@if (!isNavigationTerminal())');
    expect(JD).toContain('if (this.isNavigationTerminal()) return undefined;');
  });
});

describe('Zero-duration ETA display', () => {
  it('a valid finite short/zero duration shows Arriving, not ETA unavailable', () => {
    expect(JD).toContain("if (seconds < 60) return 'Arriving';");
  });

  it('null/undefined/non-finite duration still shows ETA unavailable', () => {
    expect(JD).toContain("if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return 'ETA unavailable';");
  });
});

describe('Negotiation opportunity alarm', () => {
  it('adds a negotiation-aware effect reusing the existing alarm', () => {
    expect(DASH).toContain('negotiationAlertEffect');
    expect(DASH).toContain('this.hybridOpportunities()');
    expect(DASH).toContain('this.startRequestSound(newest.session_id)');
  });

  it('deduplicates on session_id, never on job_id', () => {
    expect(DASH).toContain('newest.session_id');
    expect(DASH).toContain('this.activeRequestId() !== newest.session_id');
    expect(DASH).not.toMatch(/newest\.job_id/);
  });

  it('does not restart the alarm for a session already being alerted', () => {
    expect(DASH).toContain('this.activeRequestId() !== newest.session_id');
  });

  it('yields to an active job and ordinary available requests', () => {
    expect(DASH).toContain('if (activeJob || availableJobs.length > 0) return;');
  });

  it('stops when no opportunity remains', () => {
    expect(DASH).toContain('opportunities.length === 0');
    expect(DASH).toContain('this.stopAllRequestSounds();');
  });

  it('does not introduce a second audio subsystem', () => {
    expect(count(DASH, "new Audio('assets/sounds/request-notification.mp3')")).toBe(1);
    expect(DASH).toContain('startRequestSound');
  });
});

describe('Alarm ownership safety', () => {
  it('an empty ordinary-jobs refresh does not stop an actionable negotiation owner', () => {
    expect(DASH).toContain("const isNegotiationOwner = !!owner && this.hybridOpportunities().some((op) => op.session_id === owner);");
    expect(DASH).toContain('if (!isNegotiationOwner)');
  });

  it('an empty/unchanged opportunities refresh does not stop an ordinary-job owner', () => {
    expect(DASH).toContain("const isJobOwner = !!owner && this.jobs().some((job) => job.id === owner);");
    expect(DASH).toContain('if (!isJobOwner)');
  });

  it('ownership is judged against current actionable collections, not string shape', () => {
    expect(DASH).toContain('this.hybridOpportunities().some');
    expect(DASH).toContain('this.jobs().some');
  });

  it('an active job still silences all alarms unconditionally', () => {
    expect(DASH).toContain('An active job silences every incoming alarm unconditionally.');
  });
});
