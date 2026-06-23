import { Injectable, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Network } from '@capacitor/network';
import { BehaviorSubject, fromEvent, merge, map } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class NetworkService {
  private onlineSignal = signal<boolean>(typeof navigator === 'undefined' ? true : navigator.onLine);
  private onlineSubject = new BehaviorSubject<boolean>(this.onlineSignal());
  public readonly isOnline$ = this.onlineSubject.asObservable();

  constructor() {
    merge(
      fromEvent(window, 'online').pipe(map(() => true)),
      fromEvent(window, 'offline').pipe(map(() => false))
    ).subscribe(status => this.setOnline(status));

    if (Capacitor.isNativePlatform()) {
      void Network.getStatus().then(status => this.setOnline(status.connected));
      void Network.addListener('networkStatusChange', status => this.setOnline(status.connected));
    }
  }

  get isOnline(): boolean {
    return this.onlineSignal();
  }

  /**
   * Helper to normalize network/API errors
   */
  normalizeError(error: unknown): string {
    const err = error as any;
    if (!this.isOnline) {
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

  private setOnline(status: boolean): void {
    this.onlineSignal.set(status);
    this.onlineSubject.next(status);
  }
}
