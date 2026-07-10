export type DriverPricingPlan = 'starter' | 'pro';

export interface PayoutBreakdown {
  total_price: number;
  base_fare: number;
  service_fee: number;
  commission_fee: number;
  commission_rate_used: number;
  platform_fee: number;
  driver_payout: number;
  pricing_plan_used: DriverPricingPlan;
}

const roundMoney = (value: number): number => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const DEFAULT_MARKETPLACE_COMMISSION_PERCENT = 5;

export function calculatePayoutBreakdown(
  totalPrice: number,
  pricingPlan: DriverPricingPlan,
  commissionRate = DEFAULT_MARKETPLACE_COMMISSION_PERCENT
): PayoutBreakdown {
  const total = roundMoney(Math.max(0, Number(totalPrice) || 0));
  const safeCommissionRate = Number.isFinite(Number(commissionRate))
    ? Math.max(0, Number(commissionRate))
    : DEFAULT_MARKETPLACE_COMMISSION_PERCENT;

  const serviceFee = roundMoney(total * 0.1);
  const baseFare = roundMoney(Math.max(0, total - serviceFee));
  const commissionFee = pricingPlan === 'pro'
    ? 0
    : roundMoney(baseFare * (safeCommissionRate / 100));
  const driverPayout = roundMoney(Math.max(0, baseFare - commissionFee));
  const platformFee = roundMoney(serviceFee + commissionFee);

  return {
    total_price: total,
    base_fare: baseFare,
    service_fee: serviceFee,
    commission_fee: commissionFee,
    commission_rate_used: safeCommissionRate,
    platform_fee: platformFee,
    driver_payout: driverPayout,
    pricing_plan_used: pricingPlan
  };
}
