import { Injectable } from '@angular/core';
import { Booking, ServiceTypeEnum, Vehicle } from '@shared/models/booking.model';

type RequiredVehicleClass = 'bike' | 'standard' | 'xl' | 'car' | 'van';
type DriverCapability = 'bike' | 'standard' | 'xl' | 'car' | 'van';

@Injectable({
    providedIn: 'root'
})
export class VehicleCompatibilityService {
    isCompatible(job: Booking | null | undefined, vehicle: Vehicle | null | undefined): boolean {
        if (!job || !vehicle) return false;

        const required = this.getRequiredVehicleClass(job);
        const capabilities = this.getDriverCapabilities(vehicle);

        return capabilities.includes(required);
    }

    getRequiredVehicleClass(job: Booking | null | undefined): RequiredVehicleClass {
        const metadata = this.parseMetadata((job as any)?.metadata);
        const serviceSlug = String((job as any)?.service_slug || (job as any)?.service_type?.slug || '').toLowerCase();
        const raw = String(
            metadata['service_vehicle_class'] ||
            metadata['vehicle_class'] ||
            metadata['vehicleClass'] ||
            metadata['ride_details']?.vehicle_class ||
            metadata['delivery_details']?.vehicleClass ||
            metadata['errand_details']?.vehicleClass ||
            ''
        ).toLowerCase();

        const normalized = this.normalizeRequired(raw);
        if (normalized) return normalized;

        if (serviceSlug === ServiceTypeEnum.VAN || serviceSlug.includes('van') || serviceSlug.includes('moving')) {
            return 'van';
        }

        if (serviceSlug === ServiceTypeEnum.RIDE || serviceSlug.includes('ride')) {
            return 'standard';
        }

        if (serviceSlug === ServiceTypeEnum.DELIVERY || serviceSlug.includes('delivery')) {
            return 'car';
        }

        if (serviceSlug === ServiceTypeEnum.ERRAND || serviceSlug.includes('errand')) {
            return 'car';
        }

        return 'standard';
    }

    getDriverCapabilities(vehicle: Vehicle | null | undefined): DriverCapability[] {
        if (!vehicle) return [];

        const type = String((vehicle as any).type || '').toLowerCase();
        const capacity = String((vehicle as any).capacity || '').toLowerCase();
        const serviceClass = String((vehicle as any).service_class || '').toLowerCase();
        const combined = `${type} ${capacity} ${serviceClass}`;

        if (combined.includes('bike') || combined.includes('motorcycle') || combined.includes('scooter')) {
            return ['bike'];
        }

        if (combined.includes('van')) {
            return ['standard', 'xl', 'car', 'van'];
        }

        if (combined.includes('xl') || combined.includes('7')) {
            return ['standard', 'xl', 'car'];
        }

        return ['standard', 'car'];
    }

    getRequiredLabel(job: Booking | null | undefined): string {
        switch (this.getRequiredVehicleClass(job)) {
            case 'bike':
                return 'Bike';
            case 'standard':
                return 'Car';
            case 'xl':
                return 'XL car';
            case 'car':
                return 'Car';
            case 'van':
                return 'Van';
            default:
                return 'Vehicle';
        }
    }

    getVehicleLabel(vehicle: Vehicle | null | undefined): string {
        const capabilities = this.getDriverCapabilities(vehicle);

        if (capabilities.includes('van')) return 'Van';
        if (capabilities.includes('xl')) return 'XL car';
        if (capabilities.includes('bike')) return 'Bike';
        if (capabilities.includes('car')) return 'Car';

        return 'Vehicle not set';
    }

    private normalizeRequired(value: string): RequiredVehicleClass | null {
        if (!value) return null;
        if (value.includes('bike') || value.includes('motorcycle') || value.includes('scooter')) return 'bike';
        if (value.includes('van')) return 'van';
        if (value.includes('xl') || value.includes('7')) return 'xl';
        if (value.includes('standard')) return 'standard';
        if (value.includes('car')) return 'car';
        return null;
    }

    private parseMetadata(value: unknown): Record<string, any> {
        if (!value) return {};

        if (typeof value === 'object') {
            return value as Record<string, any>;
        }

        if (typeof value === 'string') {
            try {
                const parsed = JSON.parse(value);
                return parsed && typeof parsed === 'object' ? parsed : {};
            } catch {
                return {};
            }
        }

        return {};
    }
}
