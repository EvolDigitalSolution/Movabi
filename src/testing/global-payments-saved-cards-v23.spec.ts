import {describe,it,expect,vi} from 'vitest';
import {paymentPolicies,selectMarketPayment} from '../../server/services/payments/market-payment-registry';
import {StripeSavedCards} from '../../server/services/payments/stripe-saved-cards';
import {currencyDecimals,toCurrencyMinor,formatCurrencyValue} from '../app/shared/utils/currency-money';
const policy={country:'NG',currency:'NGN',provider:'stripe',merchantAccountRef:'stripe-test-ng',enabled:true,
 merchantApproved:true,adapterReady:true,payoutApproved:false,methods:['card'],capabilities:['authorise','capture','release','refund','retrieve']};
const market={countryCode:'NG',currency:'NGN',paymentEnabled:true};
describe('global payment routes',()=>{
 it('does not activate any country by default',()=>{expect(paymentPolicies(undefined)).toEqual([]);expect(()=>selectMarketPayment(market,[],'card',['authorise'])).toThrow();});
 it('uses the exact server market and account',()=>expect(selectMarketPayment(market,paymentPolicies(JSON.stringify([policy])),'card',['authorise'])).toEqual({country:'NG',currency:'NGN',provider:'stripe',merchantAccountRef:'stripe-test-ng'}));
 it.each(['enabled','merchantApproved','adapterReady'])('blocks a missing %s approval',key=>expect(()=>selectMarketPayment(market,paymentPolicies(JSON.stringify([{...policy,[key]:false}])),'card',['authorise'])).toThrow());
 it('does not infer another country from shared currency',()=>expect(()=>selectMarketPayment({...market,countryCode:'GH'},paymentPolicies(JSON.stringify([policy])),'card',['authorise'])).toThrow());
 it('cannot replace a hold with bank-transfer collection',()=>expect(()=>selectMarketPayment(market,paymentPolicies(JSON.stringify([{...policy,methods:['banktransfer'],capabilities:['retrieve']}])),'banktransfer',['authorise'])).toThrow());
 it('requires distinct payout approval',()=>expect(()=>selectMarketPayment(market,paymentPolicies(JSON.stringify([{...policy,capabilities:['payout']}])),'card',['payout'])).toThrow());
 it('rejects ambiguous approved providers',()=>expect(()=>selectMarketPayment(market,paymentPolicies(JSON.stringify([policy,{...policy,merchantAccountRef:'another'}])),'card',['authorise'])).toThrow());
 it('rejects duplicate config and invalid boolean approvals',()=>{expect(()=>paymentPolicies(JSON.stringify([policy,policy]))).toThrow();expect(()=>paymentPolicies(JSON.stringify([{...policy,enabled:'true'}]))).toThrow();});
 it('copies config and freezes method lists',()=>{const source=JSON.stringify([policy]);const p=paymentPolicies(source);expect(Object.isFrozen(p)).toBe(true);expect(Object.isFrozen(p[0].methods)).toBe(true);});
});
describe('currency amounts',()=>{
 it.each([['GBP',2,1.23,123],['NGN',2,1500.5,150050],['JPY',0,123,123],['RWF',0,123,123],['KWD',3,1.234,1234]])('handles %s without implicit FX',(currency,decimals,major,minor)=>{expect(currencyDecimals(currency as string)).toBe(decimals);expect(toCurrencyMinor(major as number,currency as string)).toBe(minor);});
 it.each([NaN,Infinity,-1,Number.MAX_SAFE_INTEGER])('rejects unsafe amount %s',n=>expect(()=>toCurrencyMinor(n,'GBP')).toThrow());
 it('rejects currency-incompatible fractions',()=>expect(()=>toCurrencyMinor(1.1,'JPY')).toThrow());
 it('formats an NGN fare without converting it from GBP',()=>expect(formatCurrencyValue(100,'NGN','en-NG')).toContain('100.00'));
});
function savedFixture(customer:string|null='cus_owner'){
 const consentRows:any[]=[];let dbError=false;
 const db:any={from:(table:string)=>{const q:any={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:customer?{customer_reference:customer}:null,error:dbError?{}:null}),
 upsert:async(row:any)=>{consentRows.push({table,row});return{error:dbError?{}:null};}};return q;}};
 const stripe:any={customers:{create:vi.fn(async()=>({id:'cus_created'}))},paymentMethods:{list:vi.fn(async()=>({data:[{id:'pm_owned',card:{brand:'visa',last4:'4242',exp_month:12,exp_year:2030}}]})),
 retrieve:vi.fn(async()=>({id:'pm_owned',type:'card',customer:'cus_owner'})),detach:vi.fn(async()=>({}))}};
 return{service:new StripeSavedCards(stripe,db),stripe,consentRows,fail:()=>dbError=true};
}
describe('saved-card consent and ownership',()=>{
 it('does not create a provider customer without consent',async()=>{const f=savedFixture(null);expect(await f.service.prepare('owner','job',false)).toEqual({});expect(f.stripe.customers.create).not.toHaveBeenCalled();expect(f.consentRows).toEqual([]);});
 it('records affirmative consent and requests only on-session reuse',async()=>{const f=savedFixture(null);expect(await f.service.prepare('owner','job',true)).toEqual({customer:'cus_created',setup_future_usage:'on_session'});expect(f.consentRows.find(x=>x.table==='payment_card_consents').row).toMatchObject({user_id:'owner',job_id:'job',provider:'stripe',version:'save-card-on-session-v1'});});
 it('does not expose provider customer references in the card list',async()=>{const f=savedFixture();expect(await f.service.list('owner')).toEqual([{id:'pm_owned',brand:'visa',last4:'4242',expMonth:12,expYear:2030}]);});
 it('revalidates saved-card ownership before use',async()=>{const f=savedFixture();expect(await f.service.prepare('owner','job',false,'pm_owned')).toEqual({customer:'cus_owner'});f.stripe.paymentMethods.retrieve.mockResolvedValue({type:'card',customer:'cus_attacker'});await expect(f.service.prepare('owner','job',false,'pm_stolen')).rejects.toThrow('Saved card not found');});
 it('cannot detach another customer card',async()=>{const f=savedFixture();f.stripe.paymentMethods.retrieve.mockResolvedValue({type:'card',customer:'cus_other'});await expect(f.service.remove('owner','pm_stolen')).rejects.toThrow();expect(f.stripe.paymentMethods.detach).not.toHaveBeenCalled();});
 it('removes an owned card at the provider',async()=>{const f=savedFixture();await f.service.remove('owner','pm_owned');expect(f.stripe.paymentMethods.detach).toHaveBeenCalledWith('pm_owned');});
 it('does not offer saved cards without a provider customer',async()=>{const f=savedFixture(null);expect(await f.service.list('owner')).toEqual([]);expect(f.stripe.paymentMethods.list).not.toHaveBeenCalled();});
 it('does not continue when consent storage fails',async()=>{const f=savedFixture();f.fail();await expect(f.service.prepare('owner','job',true)).rejects.toThrow();});
});
