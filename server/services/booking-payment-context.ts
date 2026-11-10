/** Existing checkout adapter is explicitly GB/GBP Stripe. Assignment never creates a capability. */
export function stripeCheckoutMarket(job:any):boolean {
 const country=String(job?.country_code||job?.metadata?.country_code||'').toUpperCase();
 return (!job?.metadata?.country_code || String(job.metadata.country_code).toUpperCase()===country) && country==='GB'
  && String(job?.currency_code||'').toUpperCase()==='GBP';
}
export function bookingQuoteState(job:any,now=Date.now()):'current'|'expired'|'unavailable' {
 if(['expired','cancelled','canceled','completed','settled','failed','no_driver_found'].includes(String(job?.status)))return 'expired';
 if(Number(job?.agreed_fare)>0)return 'unavailable'; // Negotiated deadlines require the persisted session, checked separately.
 const b=job?.fare_breakdown||{},m=job?.metadata||{};
 const reference=String(job?.quote_id||m.quote_id||b.quoteId||'');
 const expires=Date.parse(String(m.quote_expires_at||b.quoteExpiresAt||''));
 const version=String(b.calculationVersion||b.marketPricingVersion||'');
 if(!reference||!version||!Number.isFinite(expires))return 'unavailable';
 return expires>now?'current':'expired';
}

export function driverWalletPayoutState(supported:boolean,eligibility:any){
 if(!supported)return {payoutIntegrationAvailable:false,payoutAvailable:false,status:'Payout setup pending',message:'Payouts are not activated for this market yet. Recorded earnings remain visible.'};
 if(eligibility?.eligible)return {payoutIntegrationAvailable:true,payoutAvailable:true,status:'Payout account connected',message:'Transfers and bank payouts are separate. Your ledger retains each recorded currency.'};
 if(eligibility?.code==='ACCOUNT_UNVERIFIABLE')return {payoutIntegrationAvailable:false,payoutAvailable:false,status:'Payout verification unavailable',message:'Your payout account could not be verified. Please retry later.'};
 if(['PAYOUT_ACCOUNT_OWNER_MISMATCH','PAYOUT_COUNTRY_UNSUPPORTED'].includes(eligibility?.code))return {payoutIntegrationAvailable:false,payoutAvailable:false,status:'Payout account needs review',message:'Contact support to review the payout account linked to your driver market.'};
 return {payoutIntegrationAvailable:['NO_STRIPE_ACCOUNT','ACCOUNT_NOT_READY'].includes(eligibility?.code),payoutAvailable:false,status:'Payout setup required',message:eligibility?.reason||'Complete payout setup for your driver market.'};
}
