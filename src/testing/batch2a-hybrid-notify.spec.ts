import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Batch 2A regression tests — N34 hybrid notification URL + failure handling.
 *
 * These are STATIC source assertions. There is no HTTP or PostgreSQL runtime in
 * this workspace, so nothing here proves runtime delivery behaviour. What it
 * does prove is that the two defects that made the notify call silently
 * useless cannot silently return:
 *
 *   1. the URL was `/booking/notify-hybrid` while express mounts the router at
 *      `/api/booking`, so the request 404'd;
 *   2. `response.ok` was never inspected, so a 404 resolved as success and the
 *      failure was invisible.
 */

const HYBRID_SERVICE = 'src/app/core/services/marketplace/marketplace-hybrid.service.ts';

const source = readFileSync(HYBRID_SERVICE, 'utf8');

/** Collapse to a single whitespace-free string for formatting-insensitive matching. */
const flat = source.replace(/\s+/g, '');

describe('N34 hybrid notification URL and failure handling', () => {
    it('targets /api/booking/notify-hybrid, not /booking/notify-hybrid', () => {
        expect(flat).toContain("getApiUrl('/api/booking/notify-hybrid')");
        // The bare path missed the Express mount app.use('/api/booking', ...).
        expect(source).not.toMatch(/getApiUrl\(\s*'\/booking\/notify-hybrid'\s*\)/);
    });

    it('checks response.ok instead of discarding the Response', () => {
        expect(flat).toContain('constresponse=awaitfetch(');
        expect(flat).toContain('response.ok');
    });

    it('reports a non-2xx response diagnostically with the HTTP status', () => {
        // The failure must be visible: status code logged, not silently dropped.
        expect(flat).toContain('HTTP${response.status}');
        expect(flat).toContain('!response.ok');
    });

    it('never rejects, so a delivery failure cannot fail an already-committed mutation', () => {
        // notify() must have no `throw` anywhere — every mutation caller
        // (claimSession / driverCounterOffer / customerCounterOffer / lockFare /
        // releaseSession) commits before calling it, so a rejection here would
        // be reported to the user as an acceptance failure.
        const notifyStart = source.indexOf('private async notify(');
        expect(notifyStart, 'notify() not found').toBeGreaterThan(-1);
        const notifyBody = source.slice(notifyStart, source.indexOf('\n    async addEvent(', notifyStart));
        expect(notifyBody.length).toBeGreaterThan(0);
        expect(notifyBody).not.toMatch(/\bthrow\b/);
    });

    it('keeps the notify call sites awaited so no unhandled rejection is possible', () => {
        // Every call site must await; fire-and-forget would create a floating
        // promise if notify() ever became able to reject.
        const callSites = source.match(/this\.notify\(/g) ?? [];
        const awaitedCallSites = source.match(/await this\.notify\(/g) ?? [];
        expect(callSites.length).toBeGreaterThan(0);
        expect(awaitedCallSites.length).toBe(callSites.length);
    });
});
