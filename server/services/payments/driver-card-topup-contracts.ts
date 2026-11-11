import type { FlutterwaveAttemptStore, FlutterwaveCheckoutInput, FlutterwaveExpectedPayment } from './flutterwave-wallet-collection';
export type DriverCardExpected = FlutterwaveExpectedPayment;
export type DriverCardInput = FlutterwaveCheckoutInput & {walletAmountMinor:number; feeMinor:number};
export type DriverCardAttemptStore = FlutterwaveAttemptStore;
export interface DriverCardTopupAdapter {
  readonly provider: string;
  preflight(input:DriverCardInput):Promise<void>;
  createCheckout(input: DriverCardInput): Promise<{providerReference:string;checkoutUrl?:string;clientSecret?:string}>;
  verify(input: DriverCardExpected): Promise<{reference:string;merchantAccountRef:string;currency:string;chargedAmountMinor:number;finalStatus:'succeeded'}>;
  /** Optional: re-issue the ORIGINAL unpaid in-app payment's client secret; must never create a payment. */
  resume?(input: DriverCardExpected): Promise<{clientSecret:string}>;
  /** Optional: cancel the ORIGINAL unpaid payment at the provider so it can never succeed later. */
  cancel?(input: DriverCardExpected): Promise<{status:'canceled'}>;
}
export type DriverCardAdapterResolver = (provider:string,merchant:string)=>DriverCardTopupAdapter;
