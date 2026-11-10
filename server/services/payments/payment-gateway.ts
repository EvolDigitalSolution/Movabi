import {type PaymentAdapter,type PaymentBinding,type PaymentCapability,type PaymentCommand,PaymentLayerError,type PaymentResult,type PaymentRoute,type MarketPaymentPolicy,assertOriginalRoute,bindPayment,positiveMinor,requiredText,validateRoute} from './payment-contracts';
const operations:readonly PaymentCapability[]=['authorise','capture','release','refund','retrieve','payout'];
/** Server-owned registry. No provider credentials, country defaults or automatic failover. */
export class PaymentGateway {
 private readonly adapters=new Map<string,PaymentAdapter>();
 private readonly policies:readonly MarketPaymentPolicy[];
 constructor(adapters:readonly PaymentAdapter[]=[],policies:readonly MarketPaymentPolicy[]=[]){
  this.policies=Object.freeze(policies.map(p=>Object.freeze({...p,capabilities:Object.freeze([...p.capabilities])})));
  for(const adapter of adapters)this.register(adapter);
 }
 private key(provider:string,account:string){return JSON.stringify([provider,account]);}
 register(adapter:PaymentAdapter):void {
  if(!adapter||!['stripe','kora','fincra','paystack'].includes(adapter.provider))throw new PaymentLayerError('INVALID_PAYMENT_PROVIDER','Unknown adapter provider');
  requiredText(adapter.merchantAccountRef,'Merchant account');
  if(!Array.isArray(adapter.capabilities)||adapter.capabilities.some(v=>!operations.includes(v)))throw new PaymentLayerError('INVALID_PAYMENT_CAPABILITY','Unknown adapter capability');
  const key=this.key(adapter.provider,adapter.merchantAccountRef);
  if(this.adapters.has(key))throw new PaymentLayerError('DUPLICATE_PAYMENT_ADAPTER','An adapter is already registered for this account');
  this.adapters.set(key,adapter);
 }
 selectRoute(country:string,currency:string,required:readonly PaymentCapability[]):PaymentRoute {
  if(!/^[A-Z]{2}$/.test(country)||!/^[A-Z]{3}$/.test(currency))throw new PaymentLayerError('INVALID_PAYMENT_MARKET','Explicit country and currency are required');
  if(!Array.isArray(required)||!required.length||required.some(v=>!operations.includes(v)))throw new PaymentLayerError('INVALID_PAYMENT_CAPABILITY','Required payment capabilities must be explicit');
  const matches=this.policies.filter(p=>p.country===country&&p.currency===currency&&p.enabled===true);
  if(matches.length!==1)throw new PaymentLayerError('PAYMENT_MARKET_UNAVAILABLE','Exactly one approved payment route must be enabled for this market');
  const p=matches[0];validateRoute(p);
  if(p.merchantApproved!==true)throw new PaymentLayerError('PAYMENT_ACCOUNT_UNAPPROVED','Merchant approval is required');
  const adapter=this.adapters.get(this.key(p.provider,p.merchantAccountRef));
  if(!adapter)throw new PaymentLayerError('PAYMENT_PROVIDER_NOT_READY','This provider/account adapter is not installed');
  if(!Array.isArray(p.capabilities)||required.some(c=>!p.capabilities.includes(c)||!adapter.capabilities.includes(c)))throw new PaymentLayerError('PAYMENT_CAPABILITY_UNAVAILABLE','Required payment capability is unavailable');
  return Object.freeze({provider:p.provider,merchantAccountRef:p.merchantAccountRef,country:p.country,currency:p.currency});
 }
 execute(command:PaymentCommand):Promise<PaymentResult> {
  validateRoute(command?.route);
  if(!operations.includes(command.operation))throw new PaymentLayerError('INVALID_PAYMENT_OPERATION','Unsupported payment operation');
  const adapter=this.adapters.get(this.key(command.route.provider,command.route.merchantAccountRef));
  if(!adapter)throw new PaymentLayerError('PAYMENT_PROVIDER_NOT_READY','This provider/account adapter is not installed');
  if(!adapter.capabilities.includes(command.operation))throw new PaymentLayerError('PAYMENT_CAPABILITY_UNAVAILABLE','Payment capability is unavailable');
  if(command.operation==='authorise'||command.operation==='payout'){
   const approved=this.selectRoute(command.route.country,command.route.currency,[command.operation]);
   assertOriginalRoute(bindPayment(approved,'new-operation'),command.route);
  }
  if(command.operation!=='authorise'&&command.operation!=='payout'){
   if(!command.binding)throw new PaymentLayerError('PAYMENT_BINDING_REQUIRED','An original payment binding is required');
   assertOriginalRoute(command.binding,command.route);
  }else if(command.binding)throw new PaymentLayerError('INVALID_PAYMENT_INPUT','New payments and payouts require a new operation reference');
  if(['authorise','capture','refund','payout'].includes(command.operation))positiveMinor(command.amountMinor);
  if(command.operation!=='retrieve')requiredText(command.idempotencyKey,'Idempotency key');
  if(command.operation==='payout')requiredText(command.destinationReference,'Payout destination');
  if(command.saveForFuture){
   if(command.operation!=='authorise')throw new PaymentLayerError('INVALID_PAYMENT_INPUT','Saving requires an authorised payment customer');
   requiredText(command.customerReference,'Payment customer');
  }
  // Copy and freeze caller-owned values before asynchronous work can observe mutations.
  const binding=command.binding?bindPayment(command.binding,command.binding.paymentReference):undefined;
  const metadata=command.metadata?Object.freeze({...command.metadata}):undefined;
  if(metadata&&Object.entries(metadata).some(([key,value])=>!key||typeof value!=='string'))throw new PaymentLayerError('INVALID_PAYMENT_INPUT','Metadata must contain string values');
  const route=Object.freeze({...command.route});
  const frozen=Object.freeze({...command,route,binding,metadata});
  // No retry or provider fallback: uncertain operations require reconciliation with this adapter.
  return adapter.execute(frozen);
 }
}
