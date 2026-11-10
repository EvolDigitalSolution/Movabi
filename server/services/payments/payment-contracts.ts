/** v2.3 foundation. No country is enabled by these contracts. */
export type PaymentProvider = 'stripe' | 'kora' | 'fincra' | 'flutterwave' | 'paystack';
export type PaymentCapability = 'authorise' | 'capture' | 'release' | 'refund' | 'retrieve' | 'payout' | 'collect';
export type PaymentState = 'requires_payment_method' | 'requires_action' | 'requires_confirmation' | 'authorised' | 'captured' | 'refunded' | 'released' | 'processing' | 'submitted' | 'failed' | 'unknown';
export interface PaymentRoute {
 readonly provider:PaymentProvider;
 readonly merchantAccountRef:string;
 readonly country:string;
 readonly currency:string;
}
export interface PaymentBinding extends PaymentRoute { readonly paymentReference:string; }
export interface MarketPaymentPolicy extends PaymentRoute {
 readonly enabled:boolean;
 readonly merchantApproved:boolean;
 readonly capabilities:readonly PaymentCapability[];
}
export interface PaymentCommand {
 readonly operation:PaymentCapability;
 readonly route:PaymentRoute;
 readonly binding?:PaymentBinding;
 readonly amountMinor?:number;
 readonly idempotencyKey?:string;
 readonly customerReference?:string;
 readonly saveForFuture?:boolean;
 readonly destinationReference?:string;
 readonly metadata?:Readonly<Record<string,string>>;
}
export interface PaymentResult {
 readonly provider:PaymentProvider;
 readonly merchantAccountRef:string;
 readonly reference:string;
 readonly state:PaymentState;
 readonly currency:string;
 readonly amountMinor:number|null;
 /** Owner-only checkout handoff; never log this value. */
 readonly checkoutSecret?:string;
}
export interface PaymentAdapter {
 readonly provider:PaymentProvider;
 readonly merchantAccountRef:string;
 readonly capabilities:readonly PaymentCapability[];
 execute(command:PaymentCommand):Promise<PaymentResult>;
}
export class PaymentLayerError extends Error {
 constructor(readonly code:string,message:string){super(message);this.name='PaymentLayerError';}
}
export function requiredText(value:unknown,label:string):string {
 if(typeof value!=='string'||!value.trim()||value!==value.trim())throw new PaymentLayerError('INVALID_PAYMENT_INPUT',label+' is required');
 return value;
}
export function positiveMinor(value:unknown):number {
 if(typeof value!=='number'||!Number.isSafeInteger(value)||value<=0)throw new PaymentLayerError('INVALID_PAYMENT_AMOUNT','A positive safe integer in currency minor units is required');
 return value;
}
export function validateRoute(route:PaymentRoute):void {
 if(!route || !['stripe','kora','fincra','flutterwave','paystack'].includes(route.provider))throw new PaymentLayerError('INVALID_PAYMENT_PROVIDER','Unknown payment provider');
 requiredText(route.merchantAccountRef,'Merchant account');
 if(!/^[A-Z]{2}$/.test(route.country)||!/^[A-Z]{3}$/.test(route.currency))throw new PaymentLayerError('INVALID_PAYMENT_MARKET','Explicit country and currency are required');
}
export function bindPayment(route:PaymentRoute,reference:string):PaymentBinding {
 validateRoute(route);requiredText(reference,'Payment reference');
 return Object.freeze({provider:route.provider,merchantAccountRef:route.merchantAccountRef,country:route.country,currency:route.currency,paymentReference:reference});
}
export function assertOriginalRoute(binding:PaymentBinding,route:PaymentRoute):void {
 validateRoute(binding);validateRoute(route);requiredText(binding.paymentReference,'Original payment reference');
 if(binding.provider!==route.provider||binding.merchantAccountRef!==route.merchantAccountRef||binding.country!==route.country||binding.currency!==route.currency)
  throw new PaymentLayerError('PAYMENT_ROUTE_MISMATCH','Use the original provider, account, country and currency');
}
