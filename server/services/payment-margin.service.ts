/** Quote-time contribution protection. Estimates are allowances, not Stripe invoices. */
export interface PaymentMarginPolicy {
  version: string;
  currency: string;
  paymentPercent: number;
  paymentFixed: number;
  operatingAllowance: number;
  minimumContribution: number;
}
export class PaymentMarginService {
  static policy(currency: string): PaymentMarginPolicy {
    if (currency.toUpperCase() !== 'GBP') throw new Error('Payment cost policy is not configured for this currency');
    const number = (key: string, fallback: number) => {
      const value = process.env[key] === undefined ? fallback : Number(process.env[key]);
      if (!Number.isFinite(value) || value < 0) throw new Error('Invalid payment cost policy: ' + key);
      return value;
    };
    const paymentPercent = number('MOVABI_PAYMENT_COST_PERCENT', 3.25);
    if (paymentPercent >= 100) throw new Error('Invalid payment cost percentage');
    return { version: 'payment-margin-v1', currency: 'GBP', paymentPercent,
      paymentFixed: number('MOVABI_PAYMENT_COST_FIXED', 0.20),
      operatingAllowance: number('MOVABI_BOOKING_COST_ALLOWANCE', 0.10),
      minimumContribution: number('MOVABI_MINIMUM_BOOKING_CONTRIBUTION', 0.50) };
  }
  static evaluate(customerCharge: number, driverEntitlement: number, shoppingBudget: number, policy: PaymentMarginPolicy) {
    if (![policy.paymentPercent,policy.paymentFixed,policy.operatingAllowance,policy.minimumContribution].every(v => Number.isFinite(v) && v >= 0) || policy.paymentPercent >= 100) throw new Error('Invalid frozen payment cost policy');
    if (![customerCharge, driverEntitlement, shoppingBudget].every(v => Number.isFinite(v) && v >= 0)) throw new Error('Invalid margin inputs');
    const paymentCost = Math.ceil(((customerCharge + shoppingBudget) * policy.paymentPercent / 100 + policy.paymentFixed) * 100 - 1e-8) / 100;
    const contribution = Math.round((customerCharge - driverEntitlement - paymentCost - policy.operatingAllowance) * 100) / 100;
    return { paymentCost, contribution, passes: contribution >= policy.minimumContribution };
  }
  static protect(customerCharge: number, driverEntitlement: number, shoppingBudget: number, policy: PaymentMarginPolicy) {
    const current = this.evaluate(customerCharge, driverEntitlement, shoppingBudget, policy);
    if (current.passes) return { customerCharge, adjustment: 0, ...current, policy };
    const rate = policy.paymentPercent / 100;
    const floor = (driverEntitlement + shoppingBudget * rate + policy.paymentFixed + policy.operatingAllowance + policy.minimumContribution) / (1 - rate);
    let total = Math.ceil(Math.max(customerCharge, floor) * 100 - 1e-8) / 100;
    let result = this.evaluate(total, driverEntitlement, shoppingBudget, policy);
    // Cover penny rounding of estimated processing fees without changing driver earnings.
    for (let n = 0; !result.passes && n < 3; n++) { total = Math.round((total + 0.01) * 100) / 100; result = this.evaluate(total, driverEntitlement, shoppingBudget, policy); }
    if (!result.passes) throw new Error('Could not produce a sustainable quote');
    return { customerCharge: total, adjustment: Math.round((total - customerCharge) * 100) / 100, ...result, policy };
  }
}
