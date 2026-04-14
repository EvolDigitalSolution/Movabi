import { Injectable } from '@angular/core';
import { BookingStatus } from '../../../shared/models/booking.model';

@Injectable({
  providedIn: 'root'
})
export class BookingStatusManager {
  /**
   * Defines the allowed transitions for each booking status.
   * This centralizes the business logic for the booking lifecycle.
   */
  private readonly transitions: Record<BookingStatus, BookingStatus[]> = {
    pending: ['requested', 'cancelled'],
    requested: ['searching', 'cancelled'],
    searching: ['assigned', 'cancelled', 'no_driver_found'],
    assigned: ['accepted', 'searching', 'cancelled'],
    accepted: ['heading_to_pickup', 'arrived', 'cancelled'],
    heading_to_pickup: ['arrived', 'cancelled'],
    arrived: ['in_progress', 'arrived_at_store', 'cancelled'],
    arrived_at_store: ['shopping_in_progress', 'cancelled'],
    shopping_in_progress: ['collected', 'cancelled'],
    collected: ['en_route_to_customer', 'cancelled'],
    en_route_to_customer: ['delivered', 'cancelled'],
    delivered: ['completed', 'cancelled'],
    in_progress: ['completed', 'cancelled'],
    settled: [],
    completed: [],
    cancelled: [],
    no_driver_found: []
  };

  /**
   * Checks if a transition from current to next is allowed.
   */
  canTransition(current: BookingStatus, next: BookingStatus, isAdmin = false): boolean {
    // Admin can force any transition except from completed/cancelled
    if (isAdmin && current !== 'completed' && current !== 'cancelled') {
      return true;
    }
    return this.transitions[current]?.includes(next) || false;
  }

  /**
   * Returns a list of statuses that can be transitioned to from the current status.
   */
  getNextAllowedStatuses(current: BookingStatus): BookingStatus[] {
    return this.transitions[current] || [];
  }
}
