export type BookingStatus = 
  | 'requested'    // Initial state
  | 'searching'    // Looking for drivers
  | 'assigned'     // Driver found but not yet accepted
  | 'accepted'     // Driver accepted
  | 'arrived'      // Driver at pickup
  | 'in_progress'  // Journey started
  | 'completed'    // Journey finished
  | 'cancelled';   // Cancelled by user or driver

export type DriverStatus = 'offline' | 'online' | 'busy';

export enum ServiceTypeEnum {
  RIDE = 'ride',
  ERRAND = 'errand',
  DELIVERY = 'delivery',
  VAN = 'van'
}

export interface Vehicle {
  id: string;
  driver_id: string;
  make: string;
  model: string;
  year: number;
  license_plate: string;
  color: string;
  is_verified: boolean;
  type: 'car' | 'van' | 'motorcycle';
}

export interface DriverProfile extends Profile {
  status: DriverStatus;
  rating: number;
  total_trips: number;
  is_verified: boolean;
  subscription_status: 'active' | 'inactive' | 'expired';
  subscription_expires_at?: string;
}

export interface DriverSubscription {
  id: string;
  driver_id: string;
  plan_id: string;
  status: 'active' | 'inactive' | 'expired' | 'canceled' | 'past_due';
  starts_at: string;
  expires_at: string;
  stripe_subscription_id?: string;
  current_period_end?: string;
}

export interface Subscription {
  id: string;
  tenant_id: string;
  user_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_price_id: string | null;
  status: string;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  created_at: string;
  updated_at: string;
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  created_at: string;
}

export interface TenantUser {
  id: string;
  tenant_id: string;
  user_id: string;
  role: 'admin' | 'driver' | 'user';
  created_at: string;
}

export type JobStatus = 'pending' | 'accepted' | 'in_progress' | 'completed' | 'cancelled';

export interface Job {
  id: string;
  tenant_id: string;
  customer_id: string;
  driver_id: string | null;
  pickup_address: string;
  pickup_lat?: number;
  pickup_lng?: number;
  dropoff_address: string;
  dropoff_lat?: number;
  dropoff_lng?: number;
  price: number | null;
  estimated_distance?: number;
  estimated_price?: number;
  status: JobStatus;
  scheduled_time: string;
  created_at: string;
  updated_at: string;
  customer?: Profile;
  driver?: Profile;
  city_id?: string;
}

export interface City {
  id: string;
  name: string;
  country: string;
  lat: number;
  lng: number;
  radius_km: number;
  created_at?: string;
}

export interface JobQueueItem {
  id: string;
  job_id: string;
  tenant_id: string;
  city_id?: string;
  status: 'waiting' | 'assigned' | 'expired';
  created_at: string;
  expires_at: string;
}

export interface DriverAvailability {
  is_online: boolean;
  is_available: boolean;
  last_active_at?: string;
}

export interface DispatchResult {
  success: boolean;
  job_id: string;
  driver_id?: string;
  message?: string;
}

export interface LocationUpdate {
  id: string;
  job_id: string;
  driver_id: string;
  lat: number;
  lng: number;
  created_at: string;
}

export interface DriverLocation {
  id: string;
  driver_id: string;
  tenant_id: string;
  lat: number;
  lng: number;
  heading?: number;
  speed?: number;
  updated_at: string;
  driver?: Profile;
}

export interface DispatchCandidate extends DriverLocation {
  distance: number;
}

export interface JobEstimate {
  estimated_distance: number;
  estimated_price: number;
}

export interface Earning {
  id: string;
  driver_id: string;
  booking_id: string;
  amount: number;
  created_at: string;
}

export interface Profile {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone?: string;
  avatar_url?: string;
  role: 'customer' | 'driver' | 'admin';
  tenant_id: string;
  stripe_customer_id?: string;
  is_online?: boolean;
  is_available?: boolean;
  last_active_at?: string;
  created_at: string;
}

export interface ServiceType {
  id: string;
  name: string;
  code: ServiceTypeEnum;
  description?: string;
  base_price: number;
  price_per_km: number;
  icon: string;
  is_active: boolean;
}

export interface Booking {
  id: string;
  customer_id: string;
  driver_id?: string;
  service_type_id: string;
  service_code: ServiceTypeEnum;
  status: BookingStatus;
  total_price: number;
  pickup_address: string;
  pickup_lat: number;
  pickup_lng: number;
  dropoff_address?: string;
  dropoff_lat?: number;
  dropoff_lng?: number;
  created_at: string;
  completed_at?: string;
  service_type?: ServiceType;
  driver?: Profile;
  customer?: Profile;
}

export interface RideDetails {
  booking_id: string;
  passenger_count: number;
  notes?: string;
}

export interface ErrandDetails {
  booking_id: string;
  items_list: string[];
  estimated_budget?: number;
  delivery_instructions?: string;
}

export interface DeliveryDetails {
  booking_id: string;
  recipient_name: string;
  recipient_phone: string;
  item_description?: string;
  weight_kg?: number;
  notes?: string;
}

export interface VanDetails {
  booking_id: string;
  helper_count: number;
  floor_number?: number;
  has_elevator: boolean;
  notes?: string;
}

export interface Notification {
  id: string;
  user_id: string;
  title: string;
  body: string;
  type: 'booking' | 'system' | 'payment';
  is_read: boolean;
  created_at: string;
  metadata?: Record<string, unknown>;
}

export interface BookingStatusHistory {
  id: string;
  booking_id: string;
  status: BookingStatus;
  changed_by: string;
  created_at: string;
  notes?: string;
}
