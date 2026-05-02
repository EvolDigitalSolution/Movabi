import { Injectable, inject, signal } from '@angular/core';
import { SupabaseService } from '../supabase/supabase.service';
import { AuthService } from '../auth/auth.service';
import { AnalyticsService, AnalyticsEvent } from '../analytics/analytics.service';
import {
    DriverLocation,
    LocationMode,
    UnifiedLocation,
    LocationSource
} from '@shared/models/booking.model';
import { RealtimeChannel } from '@supabase/supabase-js';

@Injectable({
    providedIn: 'root'
})
export class LocationService {
    private supabase = inject(SupabaseService);
    private auth = inject(AuthService);
    private analytics = inject(AnalyticsService);

    private updateInterval: ReturnType<typeof setInterval> | null = null;
    private isUpdatingLocation = false;

    public locationError = signal<string | null>(null);
    public locationMode = signal<LocationMode>('auto');

    async getCurrentPosition(): Promise<GeolocationPosition | null> {
        if (!navigator.geolocation) {
            this.locationError.set('Geolocation is not supported by this browser.');
            this.locationMode.set('manual');
            return null;
        }

        this.analytics.track('location_permission_requested');

        return new Promise((resolve) => {
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    this.locationError.set(null);
                    this.locationMode.set('auto');
                    this.analytics.track('location_auto_mode_used', { success: true });
                    resolve(position);
                },
                (error: GeolocationPositionError) => {
                    let message = 'Unable to get location';
                    let event: AnalyticsEvent = 'location_permission_denied';

                    switch (error.code) {
                        case error.PERMISSION_DENIED:
                            message = 'Location permission denied. Please enable it in settings.';
                            this.locationMode.set('manual');
                            event = 'location_permission_denied';
                            break;
                        case error.POSITION_UNAVAILABLE:
                            message = 'Location information is unavailable.';
                            event = 'location_permission_denied';
                            break;
                        case error.TIMEOUT:
                            message = 'Location request timed out.';
                            event = 'location_permission_timeout';
                            break;
                    }

                    this.analytics.track(event, { error: message });
                    this.locationError.set(message);
                    resolve(null);
                },
                { enableHighAccuracy: true, timeout: 8000, maximumAge: 15000 }
            );
        });
    }

    calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
        const radiusKm = 6371;
        const dLat = this.deg2rad(lat2 - lat1);
        const dLon = this.deg2rad(lon2 - lon1);

        const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(this.deg2rad(lat1)) *
            Math.cos(this.deg2rad(lat2)) *
            Math.sin(dLon / 2) *
            Math.sin(dLon / 2);

        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return radiusKm * c;
    }

    private deg2rad(deg: number): number {
        return deg * (Math.PI / 180);
    }

    setManualMode() {
        this.locationMode.set('manual');
        this.analytics.track('location_manual_mode_selected');
    }

    setAutoMode() {
        this.locationMode.set('auto');
        this.analytics.track('location_retry_clicked');
    }

    normalizeLocation(
        source: LocationSource,
        coords?: { lat: number; lng: number },
        address?: string,
        countryCode?: string
    ): UnifiedLocation {
        const location: UnifiedLocation = {
            latitude: coords?.lat,
            longitude: coords?.lng,
            address,
            country_code: countryCode,
            source
        };

        if (source === 'map') this.analytics.track('location_map_selection_used');
        if (source === 'manual') this.analytics.track('location_manual_address_entered');

        return location;
    }

    isLocationValidForBooking(location: UnifiedLocation): boolean {
        if (!location) return false;

        switch (location.source) {
            case 'gps':
            case 'map':
                return !!(location.latitude && location.longitude);
            case 'manual':
                return !!(location.address && location.address.trim().length > 3);
            default:
                return false;
        }
    }

    getLocationValidationMessage(location: UnifiedLocation, type: 'pickup' | 'dropoff'): string | null {
        const label = type === 'pickup' ? 'Pickup' : 'Dropoff';

        if (!location || (!location.address && !location.latitude)) {
            return `${label} location is required.`;
        }

        if (location.source === 'manual' && (!location.address || location.address.trim().length <= 3)) {
            return `Please enter a valid ${label.toLowerCase()} address.`;
        }

        if ((location.source === 'gps' || location.source === 'map') && !location.latitude) {
            return `We couldn't confirm your ${label.toLowerCase()} location. Try tapping the map or entering it manually.`;
        }

        return null;
    }

    startTracking(tenantId: string | null | undefined) {
        if (!tenantId) {
            this.locationError.set('Driver tenant is missing. Location tracking is disabled.');
            return;
        }

        if (this.updateInterval) return;

        void this.trackOnce(tenantId);

        this.updateInterval = setInterval(() => {
            void this.trackOnce(tenantId);
        }, 15000);
    }

    stopTracking() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
    }

    private async trackOnce(tenantId: string) {
        if (this.isUpdatingLocation) return;

        this.isUpdatingLocation = true;

        try {
            const position = await this.getCurrentPosition();

            if (!position) return;

            const { latitude, longitude, heading, speed } = position.coords;

            await this.updateDriverLocation(
                tenantId,
                latitude,
                longitude,
                heading ?? undefined,
                speed ?? undefined
            );
        } finally {
            this.isUpdatingLocation = false;
        }
    }

    private async updateDriverLocation(
        tenantId: string,
        lat: number,
        lng: number,
        heading?: number,
        speed?: number
    ) {
        const user = this.auth.currentUser();
        if (!user?.id) return;

        const payload = {
            driver_id: user.id,
            tenant_id: tenantId,
            lat,
            lng,
            heading: heading ?? null,
            speed: speed ?? null,
            updated_at: new Date().toISOString()
        };

        const existing = await this.supabase
            .from('driver_locations')
            .select('id')
            .eq('driver_id', user.id)
            .maybeSingle();

        if (existing.error && existing.error.code !== 'PGRST116') {
            console.error('Failed to check driver location:', existing.error);
            return;
        }

        if (existing.data?.id) {
            const { error } = await this.supabase
                .from('driver_locations')
                .update(payload)
                .eq('id', existing.data.id);

            if (error) console.error('Failed to update driver location:', error);
            return;
        }

        const { error } = await this.supabase
            .from('driver_locations')
            .insert(payload);

        if (error) console.error('Failed to insert driver location:', error);
    }

    subscribeToDriverLocation(
        driverId: string,
        callback: (location: DriverLocation) => void
    ): RealtimeChannel {
        return this.supabase.client
            .channel(`driver-location:${driverId}`)
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'driver_locations',
                    filter: `driver_id=eq.${driverId}`
                },
                (payload) => {
                    callback(payload.new as DriverLocation);
                }
            )
            .subscribe();
    }

    subscribeToAllTenantLocations(
        tenantId: string,
        callback: (location: DriverLocation) => void
    ): RealtimeChannel {
        return this.supabase.client
            .channel(`tenant-locations:${tenantId}`)
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'driver_locations',
                    filter: `tenant_id=eq.${tenantId}`
                },
                (payload) => {
                    callback(payload.new as DriverLocation);
                }
            )
            .subscribe();
    }
}