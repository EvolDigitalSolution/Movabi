import { supabaseAdmin } from '../supabase.service';
import { stripe } from '../stripe.service';
import { CashRideBookingService, StripeCashFeeHold, WalletCashFeeHold } from './cash-ride-booking';

/** One lazily created cash-ride service for routes and services (nothing is built at import time). */
let instance: CashRideBookingService | null = null;
export function cashRideBooking(): CashRideBookingService {
  return instance ??= new CashRideBookingService({ db: supabaseAdmin as any,
    holdProviders: { stripe: new StripeCashFeeHold(stripe), customer_wallet: new WalletCashFeeHold(supabaseAdmin as any) },
    enabled: () => process.env.VAYDU_CASH_RIDE_BOOKING === 'true' });
}
