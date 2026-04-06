export type SubscriptionStatus = 
  | 'active' 
  | 'past_due' 
  | 'unpaid' 
  | 'canceled' 
  | 'incomplete' 
  | 'incomplete_expired' 
  | 'trialing' 
  | 'paused';

export interface Subscription {
  id: string;
  tenant_id: string;
  user_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_price_id: string | null;
  status: SubscriptionStatus;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  billing_country_code?: string | null;
  billing_currency_code?: string | null;
  billing_interval?: string | null;
  billing_amount_display?: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateCheckoutSessionRequest {
  priceId: string;
  userId: string;
  tenantId: string;
  userEmail: string;
}

export interface CreatePortalSessionRequest {
  stripeCustomerId: string;
  returnUrl: string;
}
