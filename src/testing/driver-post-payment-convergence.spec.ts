/**
 * DRIVER POST-PAYMENT + CANCELLATION CONVERGENCE.
 *
 * The driver negotiation page previously stayed on "Fare Agreed" after the
 * customer paid, because it reloaded the session/events but never the
 * authoritative job (status/payment_status/driver_id) and had no navigation
 * predicate. These assertions pin the fix.
 */
import { describe, expect, it, vi } from 'vitest';
import {runMethod, methodSource} from './source-contract';
import {driverPaidNegotiation} from '../app/shared/utils/driver-paid-negotiation';
import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';

const read = (p: string) => readFileSync(pathResolve(process.cwd(), p), 'utf8');

const NEG = read('src/app/apps/mobile/features/driver/hybrid-negotiation/hybrid-negotiation.page.ts');
const DASH = read('src/app/apps/mobile/features/driver/dashboard/dashboard.page.ts');

const transition = () => NEG.slice(NEG.indexOf('private checkForActiveJobTransition(): void {'), NEG.indexOf('private leaveToHub('));

describe('post-payment navigation predicate', () => {
  it('1. stays on negotiation when only fare_agreed/pending (no unconditional navigate)', () => {
    // the ONLY navigation to job-details is inside the guarded predicate
    const fn = transition();
    expect(fn).not.toContain('fare_agreed');
    expect(fn).not.toContain('paymentCountdown');
  });

  it.each([
    ['assigned','authorized','driver',true], ['accepted','paid','driver',true],
    ['assigned','pending','driver',false], ['fare_agreed','pending','driver',false],
    ['assigned','authorized','other',false], ['cancelled','paid','driver',false]
  ])('shows confirmed payment only for a paid owned active job: %s/%s/%s', (status,payment,owner,expected) => {
    const set = vi.fn(), stop = vi.fn(), navigate = vi.fn();
    runMethod(NEG,'checkForActiveJobTransition',{
      lifecycleResolved:false,jobDetails:()=>({id:'job',status,payment_status:payment,driver_id:owner}),
      auth:{currentUser:()=>({id:'driver'})},paymentConfirmed:{set},stopLeaseTimer:stop,
      session:()=>null,previouslyOwnedSession:false,leaveToHub:()=>{},router:{navigate}
    },[],{driverPaidNegotiation});
    expect(set).toHaveBeenLastCalledWith(expected);
    expect(stop).toHaveBeenCalledTimes(expected?1:0);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('keeps paid-job navigation behind a fresh verified Continue Job action', async () => {
    const navigate=vi.fn(),showToast=vi.fn();
    await runMethod(NEG,'openPaidJob',{
      refreshPaidJob:async()=>false,jobDetails:()=>({status:'accepted',payment_status:'paid',driver_id:'driver'}),
      auth:{currentUser:()=>({id:'driver'})},paymentConfirmed:{set:()=>{}},showToast,router:{navigate}
    },[],{driverPaidNegotiation});
    expect(navigate).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalled();
    expect(methodSource(NEG,'openPaidJob')).toContain("['/driver/job-details',this.jobId()]");
  });

  it('7. customer cancellation exits safely with the required message', () => {
    const fn = transition();
    expect(fn).toContain("'cancelled', 'canceled'");
    expect(fn).toContain("'customer_declined'");
    expect(fn).toContain("'This request was cancelled by the customer.'");
    // terminal expiry/completion also cannot be resurrected
    expect(fn).toContain("'This request is no longer available.'");
  });

  it('leaveToHub stops the countdown/lease timers before navigating away', () => {
    const fn = NEG.slice(NEG.indexOf('private leaveToHub('), NEG.indexOf('private ensureJobRealtimeSubscription('));
    expect(fn).toContain('this.stopLeaseTimer();');
    expect(fn).toContain('clearInterval(this.countdownInterval)');
    expect(fn).toContain("['/driver']");
  });
});

describe('authoritative job reload + realtime', () => {
  it('loadJobDetails now selects the authoritative status/payment/driver', () => {
    const fn = NEG.slice(NEG.indexOf('private async loadJobDetails('), NEG.indexOf('private checkForActiveJobTransition('));
    expect(fn).toMatch(/\.select\('id, status, payment_status, driver_id,/);
  });

  it('reconcile reloads the authoritative job and checks the transition', () => {
    const fn = NEG.slice(NEG.indexOf('private async reconcile(): Promise<void> {'), NEG.indexOf('private ensureRealtimeSubscription('));
    expect(fn).toContain('await this.loadJobDetails(jobId);');
    expect(fn).toContain('this.checkForActiveJobTransition();');
  });

  it('observes the job UPDATE via a scoped, id-filtered channel (payment finalization writes jobs)', () => {
    const fn = NEG.slice(NEG.indexOf('private ensureJobRealtimeSubscription(): void {'), NEG.indexOf('private disposeJobRealtimeSubscription('));
    expect(fn).toContain("table: 'jobs'");
    expect(fn).toContain('filter: `id=eq.${jobId}`');
    expect(fn).toContain('void this.reconcile();');
  });

  it('cleans up the job channel on destroy', () => {
    const fn = NEG.slice(NEG.indexOf('ngOnDestroy()'), NEG.indexOf('ngOnDestroy()') + 400);
    expect(fn).toContain('this.disposeJobRealtimeSubscription();');
    expect(fn).toContain('this.disposeRealtimeSubscription();');
  });
});

describe('active job navigation', () => {
  it('resumeActiveJob routes to the canonical /driver/job-details/:id', () => {
    const fn = DASH.slice(DASH.indexOf('async resumeActiveJob(): Promise<void> {'), DASH.indexOf('async openActiveJobChat('));
    expect(fn).toContain("['/driver/job-details', jobId]");
    expect(fn).toContain('this.refreshActiveJob();');
  });

  it('CTA wording is now "Continue Job" (not "Continue Request")', () => {
    expect(DASH).toContain("'Continue Job'");
    expect(DASH).not.toContain("'Continue Request'");
  });
});

describe('dashboard negotiation-session realtime + convergence', () => {
  const SVC = read('src/app/core/services/driver/driver.service.ts');

  it('subscribes to marketplace_negotiation_sessions exactly once', () => {
    const count = SVC.split("table: 'marketplace_negotiation_sessions'").length - 1;
    expect(count).toBe(1);
  });

  it('session events trigger authoritative refetch (trigger, never authority)', () => {
    const fn = SVC.slice(SVC.indexOf('private subscribeToNegotiationSessions() {'), SVC.indexOf('async fetchVehicle()'));
    expect(fn).toContain('void this.fetchHybridOpportunities();');
    expect(fn).toContain('void this.fetchRecoverableNegotiations();');
    expect(fn).not.toMatch(/availableJobs\.update|hybridOpportunities\.update/);
  });

  it('unsubscribes the session channel on offline', () => {
    expect(SVC).toContain("this.supabase.channel('negotiation-sessions').unsubscribe();");
  });

  it('fetchHybridOpportunities is a full replace (prunes terminal/released-away jobs)', () => {
    const fn = SVC.slice(SVC.indexOf('async fetchHybridOpportunities()'), SVC.indexOf('async claimHybridSession('));
    expect(fn).toContain('this.hybridOpportunities.set([]);');
    expect(fn).toContain('this.hybridOpportunities.set(allowed);');
  });
});
