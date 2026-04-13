import { Injectable, signal } from '@angular/core';
import { fromEvent, merge, map, startWith } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class NetworkService {
  private onlineSignal = signal<boolean>(navigator.onLine);
  
  public readonly isOnline$ = merge(
    fromEvent(window, 'online').pipe(map(() => true)),
    fromEvent(window, 'offline').pipe(map(() => false))
  ).pipe(
    startWith(navigator.onLine)
  );

  constructor() {
    this.isOnline$.subscribe(status => {
      this.onlineSignal.set(status);
    });
  }

  get isOnline(): boolean {
    return this.onlineSignal();
  }

  /**
   * Helper to normalize network/API errors
   */
  normalizeError(error: unknown): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err = error as any;
    if (!navigator.onLine) {
      return 'No internet connection. Please reconnect and try again.';
    }

    if (err.status === 0 || err.name === 'HttpErrorResponse') {
      return 'Network error. Please check your connection.';
    }

    if (err.status === 408 || err.message?.toLowerCase().includes('timeout')) {
      return 'Request timed out. Please try again.';
    }

    if (err.status >= 500) {
      return 'Server error. Our team has been notified.';
    }

    return err.message || 'An unexpected error occurred. Please try again.';
  }
}
