import type Stripe from 'stripe';
import {PaymentAdapter,PaymentCommand,PaymentLayerError,PaymentResult,PaymentState} from './payment-contracts';
function state(status:unknown):PaymentState {
 switch(status){case 'requires_payment_method':return 'requires_payment_method';case 'requires_action':return 'requires_action';case 'requires_capture':return 'authorised';case 'succeeded':return 'captured';case 'canceled':return 'released';case 'requires_confirmation':return 'requires_confirmation';case 'processing':return 'processing';default:return 'unknown';}
}
/** One explicitly supplied Stripe account. SDK retry settings and existing keys are untouched. */
export class StripePaymentAdapter implements PaymentAdapter {
 readonly provider='stripe' as const;
 readonly capabilities=Object.freeze(['authorise','capture','release','refund','retrieve','payout'] as const);
 constructor(private readonly client:Stripe,readonly merchantAccountRef='stripe-platform'){}
 async execute(command:PaymentCommand):Promise<PaymentResult> {
  if(command.route.provider!==this.provider||command.route.merchantAccountRef!==this.merchantAccountRef)throw new PaymentLayerError('PAYMENT_ROUTE_MISMATCH','Stripe account binding differs');
  const options={idempotencyKey:command.idempotencyKey};
  const reference=command.binding?.paymentReference;
  let result:any;
  switch(command.operation){
   case 'authorise':
    result=await this.client.paymentIntents.create({amount:command.amountMinor!,currency:command.route.currency.toLowerCase(),capture_method:'manual',payment_method_types:['card'],...(command.customerReference?{customer:command.customerReference}:{}),...(command.saveForFuture&&command.customerReference?{setup_future_usage:'on_session' as const}:{}),...(command.metadata?{metadata:{...command.metadata}}:{})},options);break;
   case 'capture':result=await this.client.paymentIntents.capture(reference!,{amount_to_capture:command.amountMinor!},options);break;
   case 'release':result=await this.client.paymentIntents.cancel(reference!,{},options);break;
   case 'retrieve':result=await this.client.paymentIntents.retrieve(reference!);break;
   case 'refund':result=await this.client.refunds.create({payment_intent:reference!,amount:command.amountMinor!},options);break;
   case 'payout':result=await this.client.transfers.create({amount:command.amountMinor!,currency:command.route.currency.toLowerCase(),destination:command.destinationReference!,...(command.metadata?{metadata:{...command.metadata}}:{})},options);break;
   default:throw new PaymentLayerError('INVALID_PAYMENT_OPERATION','Unsupported Stripe operation');
  }
  if(!result?.id)throw new PaymentLayerError('PAYMENT_RESPONSE_UNCONFIRMED','Provider response requires reconciliation');
  const currency=String(result.currency || '').toUpperCase();
  if(currency!==command.route.currency)throw new PaymentLayerError('PAYMENT_RESPONSE_UNCONFIRMED','Provider currency requires reconciliation');
  let outcome:PaymentState=state(result.status);
  if(command.operation==='refund')outcome=result.status==='succeeded'?'refunded':result.status==='failed'?'failed':result.status==='pending'?'processing':'unknown';
  // A Connect transfer is not proof that money reached the driver's bank account.
  if(command.operation==='payout')outcome='submitted';
  const amount=command.operation==='capture'?result.amount_received:result.amount;
  return Object.freeze({provider:this.provider,merchantAccountRef:this.merchantAccountRef,reference:String(result.id),state:outcome,currency,amountMinor:Number.isSafeInteger(amount)&&amount>=0?amount:null,
   ...(command.operation==='authorise'&&typeof result.client_secret==='string'?{checkoutSecret:result.client_secret}:{})});
 }
}
