import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import express from 'express';
import {cardWalletSetupAllowed} from '../../server/services/payments/card-wallet-policy';
import {StripeSavedCards, CARD_SETUP_CONSENT_VERSION} from '../../server/services/payments/stripe-saved-cards';
import {createCardWalletRouter} from '../../server/routes/card-wallet.routes';

const state = vi.hoisted(() => ({country:'GB',profileError:false,marketError:false,
  setup:vi.fn(),list:vi.fn(),remove:vi.fn()}));
vi.mock('../../server/services/stripe.service', () => ({stripe:{}}));
vi.mock('../../server/services/supabase.service', () => ({supabaseAdmin:{from:(table:string) => {
  const query:any = {select:()=>query,eq:()=>query,then:(resolve:any,reject:any)=>Promise.resolve({data:table==='market_payment_routes'?[{country_code:'GB',currency_code:'GBP',method:'card',provider:'stripe',merchant_account_ref:'stripe-platform',preferred:true,enabled:true,merchant_approved:true,adapter_ready:true,payout_approved:false,capabilities:['authorise','capture','release','refund','retrieve']}]:[],error:null}).then(resolve,reject),single:async()=>({data:{country_code:state.country,registration_market_city:'Manchester'},error:state.profileError?{}:null})};return query;
}}}));
vi.mock('../../server/services/market-availability.service', () => ({MarketAvailabilityService:{requireCapability:async() => {
  if(state.marketError)throw Error('Unavailable');
  return {countryCode:state.country,currency:'GBP',capabilities:{payment:true}};
}}}));
const requestId='e4ec8e63-70bf-4b70-9dfc-35a8f1195df0';
const route={country:'GB',currency:'GBP',provider:'stripe',merchantAccountRef:'stripe-platform',enabled:true,
  merchantApproved:true,adapterReady:true,payoutApproved:false,methods:['card'],capabilities:['authorise','capture','release','refund','retrieve']};
const config={cardsEnabled:true,setupEnabled:true,country:'GB',currency:'GBP',paymentEnabled:true,routes:JSON.stringify([route])};

afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
describe('standalone card saving market policy',()=>{
  it('requires the explicitly approved original account',()=>expect(cardWalletSetupAllowed(config)).toBe(true));
  it.each([{cardsEnabled:false},{setupEnabled:false},{country:'NG',currency:'NGN'},{country:null},{paymentEnabled:false},{routes:undefined},{routes:'invalid'},
    {routes:JSON.stringify([{...route,merchantApproved:false}])},{routes:JSON.stringify([{...route,merchantAccountRef:'another'}])},
    {routes:JSON.stringify([{...route,capabilities:['retrieve']}])}])('fails closed for %j',override=>expect(cardWalletSetupAllowed({...config,...override})).toBe(false));
});
function fixture(){
  const q:any={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:{customer_reference:'cus_owner'},error:null})};
  const stripe:any={setupIntents:{create:vi.fn(async()=>({id:'seti_owner',customer:'cus_owner',usage:'on_session',client_secret:'private-secret'}))},
    paymentMethods:{retrieve:vi.fn(async()=>({type:'card',customer:'cus_other'})),detach:vi.fn()}};
  return {stripe,service:new StripeSavedCards(stripe,{from:()=>q})};
}
describe('standalone card setup',()=>{
  it('uses owner customer, explicit consent, on-session usage and stable retry key',async()=>{
    const f=fixture();await f.service.beginSetup('owner',requestId,CARD_SETUP_CONSENT_VERSION);
    await f.service.beginSetup('owner',requestId.toUpperCase(),CARD_SETUP_CONSENT_VERSION);
    const [params,options]=f.stripe.setupIntents.create.mock.calls[0];
    expect(params).toMatchObject({customer:'cus_owner',payment_method_types:['card'],usage:'on_session',metadata:{vaydu_user_id:'owner',consent_version:CARD_SETUP_CONSENT_VERSION}});
    expect(params).not.toHaveProperty('amount');expect(params).not.toHaveProperty('off_session');
    expect(f.stripe.setupIntents.create.mock.calls[1][1]).toEqual(options);
  });
  it.each([['bad',CARD_SETUP_CONSENT_VERSION],[requestId,'old-version']])('rejects invalid permission or request before provider calls',async(id,version)=>{
    const f=fixture();await expect(f.service.beginSetup('owner',id,version)).rejects.toThrow();expect(f.stripe.setupIntents.create).not.toHaveBeenCalled();
  });
  it.each([{customer:'cus_other'},{usage:'off_session'},{client_secret:null}])('rejects provider mismatch %j',async override=>{
    const f=fixture();f.stripe.setupIntents.create.mockResolvedValue({id:'seti_owner',customer:'cus_owner',usage:'on_session',client_secret:'private-secret',...override});
    await expect(f.service.beginSetup('owner',requestId,CARD_SETUP_CONSENT_VERSION)).rejects.toThrow();
  });
  it('cannot remove another customer card',async()=>{const f=fixture();await expect(f.service.remove('owner','pm_other')).rejects.toThrow();expect(f.stripe.paymentMethods.detach).not.toHaveBeenCalled();});
});
async function http(method:string,path:string,body?:unknown,authenticated=true){
  const app=express();app.use(express.json());app.use('/cards',createCardWalletRouter(async req=>req.headers.authorization==='Bearer owner'?'owner':null));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  try{
    const port=(server.address() as any).port;
    const response=await fetch(`http://127.0.0.1:${port}/cards${path}`,{method,headers:{'Content-Type':'application/json',...(authenticated?{Authorization:'Bearer owner'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json(),cache:response.headers.get('cache-control')};
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}
describe('card wallet authenticated HTTP boundary',()=>{
  beforeEach(()=>{
    state.country='GB';state.profileError=false;state.marketError=false;
    vi.stubEnv('VAYDU_SAVED_CARDS_V23','true');vi.stubEnv('VAYDU_CARD_SETUP_V23','true');vi.stubEnv('VAYDU_MARKET_PAYMENT_ROUTES',JSON.stringify([route]));
    state.list.mockReset().mockResolvedValue([]);state.setup.mockReset().mockResolvedValue({clientSecret:'private-secret',setupIntentId:'seti_owner'});state.remove.mockReset().mockResolvedValue(undefined);
    vi.spyOn(StripeSavedCards.prototype,'list').mockImplementation(state.list);
    vi.spyOn(StripeSavedCards.prototype,'beginSetup').mockImplementation(state.setup);
    vi.spyOn(StripeSavedCards.prototype,'remove').mockImplementation(state.remove);
  });
  it('requires a session before listing',async()=>{expect((await http('GET','',undefined,false)).status).toBe(401);expect(state.list).not.toHaveBeenCalled();});
  it('is off when saved cards are disabled',async()=>{vi.stubEnv('VAYDU_SAVED_CARDS_V23','false');expect((await http('GET','')).status).toBe(404);});
  it('does not allow Nigerian registration to create Stripe setup',async()=>{state.country='NG';const response=await http('POST','/setup',{requestId,consentVersion:CARD_SETUP_CONSENT_VERSION});expect(response.status).toBe(409);expect(state.setup).not.toHaveBeenCalled();});
  it('keeps removal available after a market change',async()=>{state.country='NG';expect((await http('DELETE','/pm_owner')).status).toBe(200);expect(state.remove).toHaveBeenCalledWith('owner','pm_owner');});
  it('rejects injected provider, owner, amount or country',async()=>{for(const key of ['provider','userId','amount','country'])expect((await http('POST','/setup',{requestId,consentVersion:CARD_SETUP_CONSENT_VERSION,[key]:'forged'})).status).toBe(400);expect(state.setup).not.toHaveBeenCalled();});
  it('blocks setup while leaving owned cards visible if setup flag is off',async()=>{vi.stubEnv('VAYDU_CARD_SETUP_V23','false');const wallet=await http('GET','');expect(wallet.body.canAdd).toBe(false);expect(wallet.cache).toBe('no-store');expect((await http('POST','/setup',{requestId,consentVersion:CARD_SETUP_CONSENT_VERSION})).status).toBe(409);});
  it('returns setup only after profile and market checks',async()=>{const response=await http('POST','/setup',{requestId,consentVersion:CARD_SETUP_CONSENT_VERSION});expect(response.status).toBe(200);expect(response.cache).toBe('no-store');expect(state.setup).toHaveBeenCalledWith('owner',requestId,CARD_SETUP_CONSENT_VERSION);});
  it('does not continue when profile query fails',async()=>{state.profileError=true;expect((await http('POST','/setup',{requestId,consentVersion:CARD_SETUP_CONSENT_VERSION})).status).toBe(503);expect(state.setup).not.toHaveBeenCalled();});
  it('does not continue when market capability is unavailable',async()=>{state.marketError=true;expect((await http('POST','/setup',{requestId,consentVersion:CARD_SETUP_CONSENT_VERSION})).status).toBe(409);expect(state.setup).not.toHaveBeenCalled();});
});
