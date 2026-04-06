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
    requested: ['searching', 'cancelled'],
    searching: ['assigned', 'accepted', 'cancelled'],
    assigned: ['accepted', 'searching', 'cancelled'],
    accepted: ['arrived', 'cancelled'],
    arrived: ['in_progress', 'cancelled'],
    in_progress: ['completed', 'cancelled'],
    completed: [],
    cancelled: []
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
