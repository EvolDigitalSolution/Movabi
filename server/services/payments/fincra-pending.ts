import { PaymentLayerError } from './payment-contracts';
/** Explicit placeholder, not an installed adapter. No credentials or network calls. */
export const FINCRA_STATUS = Object.freeze({provider: 'fincra' as const, enabled: false,
  adapterReady: false, payoutApproved: false, capabilities: Object.freeze([]), reason: 'KYC_AND_API_ACCESS_PENDING'});
export function requireFincraReady(): never {
  throw new PaymentLayerError('PAYMENT_PROVIDER_NOT_READY', 'Fincra is pending KYC, API access and integration validation');
}
