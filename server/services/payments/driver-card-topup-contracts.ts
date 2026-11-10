import type { FlutterwaveAttemptStore, FlutterwaveCheckoutInput, FlutterwaveExpectedPayment } from './flutterwave-wallet-collection';
export type DriverCardExpected = FlutterwaveExpectedPayment;
export type DriverCardInput = FlutterwaveCheckoutInput & {walletAmountMinor:number; feeMinor:number};
export type DriverCardAttemptStore = FlutterwaveAttemptStore;
export interface DriverCardTopupAdapter {
  readonly provider: string;
  preflight(input:DriverCardInput):Promise<void>;
  createCheckout(input: DriverCardInput): Promise<{providerReference:string;checkoutUrl?:string;clientSecret?:string}>;
  verify(input: DriverCardExpected): Promise<{reference:string;merchantAccountRef:string;currency:string;chargedAmountMinor:number;finalStatus:'succeeded'}>;
  recover?(input: DriverCardExpected): Promise<{status:string;clientSecret?:string}>;
}
export type DriverCardAdapterResolver = (provider:string,merchant:string)=>DriverCardTopupAdapter;
