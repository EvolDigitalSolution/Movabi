export type BookingStatus = 
  | 'pending'      // Initial state for some flows
  | 'requested'    // Initial state
  | 'searching'    // Looking for drivers
  | 'assigned'     // Driver found but not yet accepted
  | 'accepted'     // Driver accepted
  | 'arrived'      // Driver at pickup
  | 'heading_to_pickup'
  | 'arrived_at_store'
  | 'shopping_in_progress'
  | 'collected'
  | 'en_route_to_customer'
  | 'delivered'
  | 'in_progress'  // Journey started
  | 'completed'    // Journey finished
  | 'cancelled'    // Cancelled by user or driver
  | 'no_driver_found' // Search timeout
  | 'settled';     // Final state for funded errands

export type DriverStatus = 'offline' | 'online' | 'busy';

export enum ServiceTypeEnum {
  RIDE = 'ride',
  ERRAND = 'errand',
  DELIVERY = 'delivery',
  VAN = 'van-moving'
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
  capacity?: string; // e.g., "4 passengers", "2 tons"
}

export interface DriverProfile extends Profile {
  status: DriverStatus;
  rating: number;
  total_trips: number;
  is_verified: boolean;
  subscription_status: 'active' | 'inactive' | 'expired';
  subscription_expires_at?: string;
  pricing_plan: 'starter' | 'pro';
  commission_rate: number;
  
  // Performance Metrics (Additive)
  completed_jobs?: number;
  cancelled_jobs?: number;
  acceptance_rate?: number; // percentage
  completion_rate?: number; // percentage
  on_time_performance?: number; // percentage
  total_earnings?: number;
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

export interface SubscriptionPlan {
  id: string;
  plan_code: string;
  country_code: string;
  currency_code: string;
  stripe_price_id: string;
  amount: number;
  interval: string;
  display_name: string;
  features: string[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
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
  currency_code: string;
  country_code: string;
  billing_country_code?: string | null;
  billing_currency_code?: string | null;
  billing_interval?: string | null;
  billing_amount_display?: string | null;
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

export type JobStatus = BookingStatus;

export type JobEventType = 
  | 'job_created'
  | 'payment_initiated'
  | 'payment_succeeded'
  | 'payment_failed'
  | 'driver_assigned'
  | 'driver_accepted'
  | 'driver_arrived'
  | 'job_started'
  | 'job_completed'
  | 'job_cancelled'
  | 'admin_action'
  | 'status_change'
  | 'errand_spending_recorded'
  | 'over_budget_requested'
  | 'errand_receipt_uploaded';

export interface JobEvent {
  id: string;
  job_id: string;
  event_type: JobEventType;
  actor_id?: string;
  actor_role?: 'customer' | 'driver' | 'admin' | 'system';
  metadata?: Record<string, unknown>;
  created_at: string;
  notes?: string;
}

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
  commission_fee?: number;
  commission_rate_used?: number;
  base_fare?: number;
  service_fee?: number;
  platform_fee?: number;
  driver_payout?: number;
  pricing_plan_used?: 'starter' | 'pro';
  currency_code: string;
  country_code: string;
  estimated_distance?: number;
  estimated_duration?: number;
  estimated_price?: number;
  status: JobStatus;
  payment_status?: 'pending' | 'paid' | 'failed';
  payment_intent_id?: string;
  scheduled_time: string;
  created_at: string;
  updated_at: string;
  customer?: Profile;
  driver?: Profile;
  total_price?: number;
  service_type?: ServiceType;
  service_slug?: ServiceTypeEnum;
  city_id?: string;
  metadata?: Record<string, unknown>;
  errand_details?: ErrandDetails;
  errand_funding?: ErrandFunding;
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
  estimated_duration?: number;
  pickup_lat?: number;
  pickup_lng?: number;
  dropoff_lat?: number;
  dropoff_lng?: number;
}

export interface Earning {
  id: string;
  driver_id: string;
  job_id: string;
  amount: number;
  commission_fee: number;
  commission_rate_used: number;
  pricing_plan_used: 'starter' | 'pro';
  currency_code: string;
  country_code: string;
  created_at: string;
}

export type AccountStatus = 'active' | 'suspended' | 'banned' | 'disabled';

export type VerificationStatus =
    | 'draft'
    | 'under_review'
    | 'action_required'
    | 'approved';

export interface Profile {
    id: string;
    first_name: string;
    last_name: string;
    email: string;
    phone?: string;
    avatar_url?: string;
    role: 'customer' | 'driver' | 'admin';
    tenant_id: string;
    pricing_plan: 'starter' | 'pro';
    commission_rate: number;
    currency_code: string;
    country_code: string;
    stripe_customer_id?: string;
    onboarding_completed: boolean;
    is_verified?: boolean;
    is_online?: boolean;
    is_available?: boolean;
    last_active_at?: string;
    account_status: AccountStatus;
    moderation_reason?: string;
    moderated_at?: string;
    moderated_by?: string;
    created_at: string;
    stripe_connect_status?: 'not_started' | 'pending' | 'restricted' | 'enabled';
    driver_license_url?: string | null;
    insurance_url?: string | null;
    verification_status?: VerificationStatus;
    verification_notes?: string | null;
    verification_items?: string[] | null;
    verified_at?: string | null;
}

export interface DriverAccount {
    id: string;
    user_id: string;
    tenant_id: string;
    stripe_account_id: string;
    charges_enabled: boolean;
    payouts_enabled: boolean;
    onboarding_status: 'not_started' | 'pending' | 'restricted' | 'enabled';
    onboarding_complete: boolean;
    created_at: string;
    updated_at: string;
}
export interface Wallet {
  user_id: string;
  available_balance: number;
  reserved_balance: number;
  currency_code: string;
  updated_at: string;
}

export interface ErrandFunding {
  id: string;
  job_id: string;
  customer_id: string;
  amount_reserved: number;
  status: 'pending' | 'reserved' | 'approved' | 'settled' | 'cancelled';
  over_budget_status: 'none' | 'requested' | 'approved' | 'rejected';
  over_budget_amount: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ServiceType {
  id: string;
  name: string;
  slug: ServiceTypeEnum;
  description?: string;
  base_price: number;
  price_per_km: number;
  icon: string;
  is_active: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface Booking {
  id: string;
  customer_id: string;
  driver_id?: string;
  service_type_id: string;
  service_slug: ServiceTypeEnum;
  status: BookingStatus;
  payment_status?: 'pending' | 'paid' | 'failed';
  price: number;
  total_price: number;
  tenant_id: string;
  currency_code: string;
  country_code: string;
  scheduled_time: string;
  updated_at: string;
  commission_fee?: number;
  commission_rate_used?: number;
  base_fare?: number;
  service_fee?: number;
  platform_fee?: number;
  driver_payout?: number;
  pricing_plan_used?: 'starter' | 'pro';
  pickup_address: string;
  pickup_lat: number;
  pickup_lng: number;
  dropoff_address?: string;
  dropoff_lat?: number;
  dropoff_lng?: number;
  created_at: string;
  completed_at?: string;
  estimated_distance?: number;
  estimated_duration?: number;
  distance_meters?: number;
  duration_seconds?: number;
  service_type?: ServiceType;
  driver?: Profile;
  customer?: Profile;
  metadata?: Record<string, unknown>;
  errand_details?: ErrandDetails;
  errand_funding?: ErrandFunding;
}

export interface RideDetails {
  job_id: string;
  passenger_count: number;
  notes?: string;
}

export interface ErrandDetails {
  job_id: string;
  items_list: string[];
  estimated_budget?: number;
  delivery_instructions?: string;
  actual_spending?: number;
  spending_notes?: string;
  receipt_url?: string;
  customer_phone?: string;
  recipient_phone?: string;
  recipient_name?: string;
  substitution_rule?: 'contact_me' | 'best_match' | 'do_not_substitute';
}

export interface DeliveryDetails {
  job_id: string;
  recipient_name: string;
  recipient_phone: string;
  item_description?: string;
  weight_kg?: number;
  notes?: string;
}

export interface VanDetails {
  job_id: string;
  helper_count: number;
  floor_number?: number;
  has_elevator: boolean;
  notes?: string;
}

export type LocationSource = 'gps' | 'manual' | 'map';
export type LocationMode = 'auto' | 'manual';

export interface UnifiedLocation {
  latitude?: number;
  longitude?: number;
  address?: string;
  country_code?: string;
  source: LocationSource;
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
  job_id: string;
  status: BookingStatus;
  changed_by: string;
  created_at: string;
  notes?: string;
}
