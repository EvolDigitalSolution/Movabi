/** Billing status controls commission benefits only; never acquisition access. */
export function hasActiveCommissionSubscription(status:unknown,periodEnd:string|null|undefined,now=Date.now()):boolean {
 if(status!=='active')return false;
 if(periodEnd==null)return true;
 const expiry=Date.parse(periodEnd);
 return Number.isFinite(expiry)&&expiry>now;
}
