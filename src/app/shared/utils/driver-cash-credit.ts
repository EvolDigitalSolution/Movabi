/** Server cash-credit money is exact minor-unit text, never a display-country conversion. */
export interface DriverCashCreditStatus {
 driverId:string; tenantId:string; country:string; currency:string;
 pilotEnabled:boolean; enrolled:boolean;
 balance:{currency:string;consistent:boolean;availableMinor:string;heldMinor:string;deficitMinor:string;eligibleDepositsMinor:string};
 topupAvailable:false; payoutAvailable:false; acceptanceAuthority:'database';
}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const minor=(value:unknown):value is string=>typeof value==='string'&&/^(0|[1-9][0-9]{0,39})$/.test(value);
export function parseDriverCashCredit(raw:unknown,owner:string):DriverCashCreditStatus {
 if(!raw||typeof raw!=='object')throw Error('Cash credit response unavailable.');
 const s=raw as Partial<DriverCashCreditStatus>;
 if(!uuid(owner)||s.driverId!==owner||!uuid(s.tenantId)||typeof s.country!=='string'||!(/^[A-Z]{2}$/).test(s.country)
 ||typeof s.currency!=='string'||!(/^[A-Z]{3}$/).test(s.currency)||typeof s.pilotEnabled!=='boolean'||typeof s.enrolled!=='boolean'
 ||s.topupAvailable!==false||s.payoutAvailable!==false||s.acceptanceAuthority!=='database')throw Error('Cash credit response unavailable.');
 const b=s.balance;
 if(!b||b.currency!==s.currency||typeof b.consistent!=='boolean'||!minor(b.availableMinor)||!minor(b.heldMinor)
 ||!minor(b.deficitMinor)||!minor(b.eligibleDepositsMinor))throw Error('Cash credit response unavailable.');
 return {driverId:owner,tenantId:s.tenantId,country:s.country,currency:s.currency,pilotEnabled:s.pilotEnabled,enrolled:s.enrolled,
  balance:{currency:b.currency,consistent:b.consistent,availableMinor:b.availableMinor,heldMinor:b.heldMinor,deficitMinor:b.deficitMinor,eligibleDepositsMinor:b.eligibleDepositsMinor},
  topupAvailable:false,payoutAvailable:false,acceptanceAuthority:'database'};
}
/** Same ISO exponent contract as the applied wallet ledger; preserve all digits. */
export function formatCashCreditMinor(value:string,currency:string):string {
 if(!minor(value)||!(/^[A-Z]{3}$/).test(currency))return 'Amount unavailable';
 const zero=['BIF','CLP','DJF','GNF','JPY','KMF','KRW','MGA','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF'];
 const three=['BHD','IQD','JOD','KWD','LYD','OMR','TND'];
 const exponent=zero.includes(currency)?0:three.includes(currency)?3:2;
 const padded=value.padStart(exponent+1,'0');
 const whole=exponent?padded.slice(0,-exponent):padded;
 const grouped=whole.replace(/\B(?=(\d{3})+(?!\d))/g,',');
 return currency+' '+grouped+(exponent?'.'+padded.slice(-exponent):'');
}
export function cashCreditNeedsReview(s:DriverCashCreditStatus):boolean {
 return !s.balance.consistent||s.balance.deficitMinor!=='0';
}
/**
 * Cash-RIDE state only, from the server's cash-credit status (pilot switch, this driver's
 * enrolment for the market, balance consistency). Whether a top-up is possible is a separate
 * server decision (the top-up /availability endpoint) and is never claimed here.
 */
export function cashCreditStatusMessage(s:DriverCashCreditStatus):string {
 if(cashCreditNeedsReview(s))return 'Cash credit needs review before another cash ride.';
 if(!s.pilotEnabled)return 'Cash rides are not enabled in '+s.country+' yet. Your credit is kept for when they are.';
 if(!s.enrolled)return 'Cash rides are not approved for this account in '+s.country+' yet. Your credit is kept.';
 return 'Cash rides are enabled for you in '+s.country+'. Credit is checked for each ride.';
}
/** Top-up line from the top-up service's own decision; independent of cash-ride enablement. */
export function topupAvailabilityMessage(check:'checking'|'available'|'unavailable'):string {
 return check==='checking'?'Checking top-up availability…':check==='available'?'':'Top-ups are unavailable right now.';
}
