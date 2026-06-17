import { describe, expect, it } from 'vitest';
import { BookingStatusManager } from './booking-status.manager';

describe('BookingStatusManager', () => {
  const manager = new BookingStatusManager();

  it('allows normal customer ride lifecycle transitions', () => {
    expect(manager.canTransition('pending', 'requested')).toBe(true);
    expect(manager.canTransition('requested', 'searching')).toBe(true);
    expect(manager.canTransition('searching', 'assigned')).toBe(true);
    expect(manager.canTransition('accepted', 'heading_to_pickup')).toBe(true);
    expect(manager.canTransition('heading_to_pickup', 'arrived')).toBe(true);
    expect(manager.canTransition('in_progress', 'completed')).toBe(true);
  });

  it('blocks unsafe boundary transitions', () => {
    expect(manager.canTransition('requested', 'completed')).toBe(false);
    expect(manager.canTransition('no_driver_found', 'accepted')).toBe(false);
    expect(manager.canTransition('completed', 'cancelled')).toBe(false);
    expect(manager.canTransition('cancelled', 'requested')).toBe(false);
  });

  it('allows admin recovery before terminal states only', () => {
    expect(manager.canTransition('searching', 'accepted', true)).toBe(true);
    expect(manager.canTransition('completed', 'requested', true)).toBe(false);
    expect(manager.canTransition('cancelled', 'requested', true)).toBe(false);
  });
});
