/**
 * ACTIVE-JOB CARD ACCESSIBILITY + MAPLIBRE STYLE READINESS + OPPORTUNITY FETCH RACE.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';

const read = (p: string) => readFileSync(pathResolve(process.cwd(), p), 'utf8');
const DASH = read('src/app/apps/mobile/features/driver/dashboard/dashboard.page.ts');
const MAP = read('src/app/core/services/maps/map-renderer.service.ts');
const SVC = read('src/app/core/services/driver/driver.service.ts');

describe('active-job card accessibility', () => {
  it('card region is a clickable button that resumes exactly once', () => {
    // the info region (sibling of the footer buttons) owns card activation
    expect(DASH).toContain('role="button"');
    expect(DASH).toContain('tabindex="0"');
    expect(DASH).toContain('(click)="resumeActiveJob()"');
  });

  it('Enter and Space both resume', () => {
    expect(DASH).toContain('(keydown.enter)="resumeActiveJob()"');
    expect(DASH).toContain('(keydown.space)="onActiveCardSpace($event)"');
  });

  it('Space handler suppresses page scroll then resumes', () => {
    const fn = DASH.slice(DASH.indexOf('onActiveCardSpace(event: Event): void {'), DASH.indexOf('async openActiveJobChat('));
    expect(fn).toContain('event.preventDefault();');
    expect(fn).toContain('void this.resumeActiveJob();');
  });

  it('Continue Job CTA still resumes (no stale "Continue Request")', () => {
    expect(DASH).toContain('Continue Job');
    expect(DASH).not.toContain('Continue Request');
  });
});

describe('map style readiness', () => {
  it('drawRoute defers when the style is not yet loaded', () => {
    const fn = MAP.slice(MAP.indexOf('drawRoute(route: RouteSummary) {'), MAP.indexOf('private ensureRouteStyleListener()'));
    expect(fn).toContain('this.pendingRoute = route;');
    expect(fn).toContain('if (!this.map.isStyleLoaded())');
    expect(fn).toContain('this.ensureRouteStyleListener();');
  });

  it('deferral uses MapLibre style.load ONCE, with latest-route-wins and no listener leak', () => {
    const fn = MAP.slice(MAP.indexOf('private ensureRouteStyleListener(): void {'), MAP.indexOf('private renderRoute('));
    expect(fn).toContain('this.map.once(\'style.load\'');
    expect(fn).toContain('if (!this.map || this.routeStyleListenerRegistered) return;');
    expect(fn).toContain('this.routeStyleListenerRegistered = true;');
    expect(fn).toContain('const route = this.pendingRoute;');
    expect(fn).toContain('this.pendingRoute = null;');
  });

  it('deferred callback is harmless if the map was destroyed before readiness', () => {
    const fn = MAP.slice(MAP.indexOf('private ensureRouteStyleListener(): void {'), MAP.indexOf('private renderRoute('));
    expect(fn).toContain('if (route && this.map && this.map.isStyleLoaded())');
  });

  it('actual source/layer work is isolated in renderRoute', () => {
    const fn = MAP.slice(MAP.indexOf('private renderRoute(route: RouteSummary) {'), MAP.indexOf('clearRoute() {'));
    expect(fn).toContain('this.clearRoute();');
    expect(fn).toContain('this.map.addSource(this.routeSourceId');
    expect(fn).toContain('this.map.addLayer({');
  });

  it('clearRoute is safe before style load (no premature removeLayer/removeSource)', () => {
    const fn = MAP.slice(MAP.indexOf('clearRoute() {'), MAP.indexOf('drawHeatmap('));
    expect(fn).toContain('if (!this.map || !this.map.isStyleLoaded()) return;');
  });

  it('destroyMap resets the pending-route/listener state', () => {
    const fn = MAP.slice(MAP.indexOf('destroyMap() {'), MAP.indexOf('onUserMapGesture('));
    expect(fn).toContain('this.pendingRoute = null;');
    expect(fn).toContain('this.routeStyleListenerRegistered = false;');
  });
});

describe('opportunity fetch race protection', () => {
  it('fetchHybridOpportunities discards a superseded (stale) response', () => {
    const fn = SVC.slice(SVC.indexOf('async fetchHybridOpportunities(): Promise<HybridOpportunity[]> {'), SVC.indexOf('async claimHybridSession('));
    expect(fn).toContain('const token = ++this.hybridFetchToken;');
    expect(fn).toContain('if (token !== this.hybridFetchToken) return this.hybridOpportunities();');
    // token is re-checked after BOTH awaits (fetch + eligibility checks)
    expect(fn.split('if (token !== this.hybridFetchToken) return this.hybridOpportunities();').length - 1).toBeGreaterThanOrEqual(2);
  });
});
