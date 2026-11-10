/**
 * Activity history fetch — malformed list responses must surface the caller's
 * error handling instead of silently rendering an empty history.
 *
 * Drives the real BookingService.getHistory() over a stubbed Supabase client.
 */
import '@angular/compiler';
import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@ionic/angular', () => ({ IonicModule: class IonicModule {} }));
vi.mock('@ionic/angular/standalone', () => ({}));
vi.mock('@angular/router', () => ({ Router: class Router {} }));
vi.mock('@angular/common', () => ({ CommonModule: class CommonModule {} }));

import { BookingService } from '../app/core/services/booking/booking.service';

/** A real BookingService with a stubbed Supabase/auth surface. */
function makeService(response: { data: unknown; error: unknown }) {
  const svc = Object.create(BookingService.prototype) as any;
  svc.auth = { currentUser: () => ({ id: 'user-1' }) };
  svc.bookingHistory = signal<any[]>([]);
  svc.pendingMarketplaceBookings = signal<any[]>([]);
  svc.supabase = {
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => Promise.resolve(response)
        })
      })
    })
  };
  return svc as BookingService;
}

describe('getHistory response validation', () => {
  it('throws on a non-array object so the error path runs (never an empty list)', async () => {
    const svc = makeService({ data: { message: 'not a list' }, error: null });
    await expect(svc.getHistory()).rejects.toThrow(/not a list/i);
  });

  it('throws on a single object row instead of treating it as history', async () => {
    const svc = makeService({ data: { id: 'job-1', status: 'cancelled' }, error: null });
    await expect(svc.getHistory()).rejects.toThrow(/not a list/i);
  });

  it('throws on a null body rather than rendering nothing', async () => {
    const svc = makeService({ data: null, error: null });
    await expect(svc.getHistory()).rejects.toThrow(/not a list/i);
  });

  it('throws when the response carries an error', async () => {
    const svc = makeService({ data: null, error: { message: 'boom' } });
    await expect(svc.getHistory()).rejects.toThrow();
  });

  it('accepts an empty array as a valid empty history', async () => {
    const svc = makeService({ data: [], error: null });
    await expect(svc.getHistory()).resolves.toBeUndefined();
    expect(svc.bookingHistory()).toEqual([]);
  });
});
