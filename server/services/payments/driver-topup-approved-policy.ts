import { PaymentLayerError } from './payment-contracts';
/** User approval dated 2026-10-27; activation still requires one reviewed test scope. */
export const DRIVER_SANDBOX_FEE_VERSION = 'vaydu-driver-card-5pct-wallet-v1';
export const DRIVER_SANDBOX_FEE_LABEL = 'Card fee (5%)';
export function assertApprovedDriverFee(policy: any): void {
  if (!policy || policy.version !== DRIVER_SANDBOX_FEE_VERSION || policy.fee_basis !== 'wallet' ||
      policy.fee_basis_points !== 500 || Number(policy.fee_fixed_minor) !== 0 || policy.fee_cap_minor != null ||
      policy.rounding !== 'half_up')
    throw new PaymentLayerError('PAYMENT_FEE_MISSING', 'Approved sandbox Card fee is unavailable');
}
