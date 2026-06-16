import { Injectable } from '@angular/core';
import { Booking, ServiceTypeEnum, Vehicle } from '@shared/models/booking.model';

type RequiredVehicleClass = 'bike' | 'standard' | 'xl' | 'car' | 'small_van' | 'large_van' | 'minibus';
type DriverCapability = 'bike' | 'standard' | 'xl' | 'car' | 'small_van' | 'large_van' | 'minibus';

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
            return 'small_van';
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

        if (combined.includes('minibus') || combined.includes('7 seater') || combined.includes('7-seater') || combined.includes('xl') || combined.includes('7')) {
            return ['standard', 'xl', 'minibus', 'car'];
        }

        if (combined.includes('large_van') || combined.includes('large van') || combined.includes('luton')) {
            return ['standard', 'xl', 'car', 'small_van', 'large_van'];
        }

        if (combined.includes('small_van') || combined.includes('small van') || combined.includes('van')) {
            return ['standard', 'car', 'small_van'];
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
            case 'minibus':
                return '7 seater';
            case 'small_van':
                return 'Small van';
            case 'large_van':
                return 'Large van';
            default:
                return 'Vehicle';
        }
    }

    getVehicleLabel(vehicle: Vehicle | null | undefined): string {
        const capabilities = this.getDriverCapabilities(vehicle);

        if (capabilities.includes('large_van')) return 'Large van';
        if (capabilities.includes('small_van')) return 'Small van';
        if (capabilities.includes('minibus')) return '7 seater';
        if (capabilities.includes('xl')) return 'XL car';
        if (capabilities.includes('bike')) return 'Bike';
        if (capabilities.includes('car')) return 'Car';

        return 'Vehicle not set';
    }

    private normalizeRequired(value: string): RequiredVehicleClass | null {
        if (!value) return null;
        if (value.includes('bike') || value.includes('motorcycle') || value.includes('scooter')) return 'bike';
        if (value.includes('minibus') || value.includes('7 seater') || value.includes('7-seater')) return 'minibus';
        if (value.includes('xl') || value.includes('7')) return 'xl';
        if (value.includes('large_van') || value.includes('large van') || value.includes('luton')) return 'large_van';
        if (value.includes('small_van') || value.includes('small van') || value.includes('van')) return 'small_van';
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
