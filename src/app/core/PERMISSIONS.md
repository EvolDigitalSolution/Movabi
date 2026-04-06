# Movabi Permission Boundaries

This document outlines the security and permission boundaries for the Movabi application. These boundaries are enforced at three levels:
1. **Database Level (Firestore/Supabase RLS)**: The ultimate source of truth.
2. **Service Level (Angular Core Services)**: Business logic enforcement.
3. **UI Level (Angular Guards & Components)**: User experience and navigation.

## Roles

### 1. Customer
- **Permissions**:
    - Create bookings.
    - Read/Update their own profile.
    - Read their own bookings and status history.
    - Rate drivers for their completed bookings.
- **Restrictions**:
    - Cannot access driver-specific data (earnings, documents, vehicle details of others).
    - Cannot update booking status to 'accepted', 'arrived', etc. (only 'cancelled' or 'requested').
    - Cannot access admin dashboards.

### 2. Driver
- **Permissions**:
    - Read/Update their own profile (including vehicle and documents).
    - Toggle online/offline status (requires active subscription).
    - Read available jobs ('searching' status).
    - Accept jobs (requires active subscription).
    - Update status of assigned jobs ('arrived', 'in_progress', 'completed').
    - Read their own earnings.
- **Restrictions**:
    - Cannot create bookings for others.
    - Cannot access other drivers' data.
    - Cannot access customer PII unless assigned to a job.
    - Cannot access admin dashboards.

### 3. Admin
- **Permissions**:
    - Read/Update all profiles.
    - Verify drivers and vehicles.
    - Manage service types and pricing.
    - View all bookings and system statistics.
- **Restrictions**:
    - Should only perform administrative actions via the dedicated Admin App.

## Enforcement Points

### Service Logic (Hardening)
- **Subscription Checks**: `DriverService` must verify `subscription_status === 'active'` before allowing `toggleOnline` or `acceptJob`.
- **Status Transitions**: `BookingService` uses `BookingStatusManager` to ensure bookings follow a valid lifecycle (e.g., cannot go from 'requested' to 'completed' directly).
- **Payload Validation**: `BookingService` validates that required details (e.g., `passenger_count`) are present for specific service types.

### Route Guards
- `AuthGuard`: Ensures the user is authenticated.
- `RoleGuard`: Restricts access to features based on user role (Customer vs. Driver vs. Admin).
- `SubscriptionGuard`: Prevents drivers from accessing job-related screens without an active subscription.

## Data Security (RLS)
- **Bookings**: `customer_id == auth.uid()` for customers; `driver_id == auth.uid() OR status == 'searching'` for drivers.
- **Profiles**: `id == auth.uid()` for read/write; public fields (name, avatar) readable by assigned parties.
- **Earnings**: `driver_id == auth.uid()` only.
