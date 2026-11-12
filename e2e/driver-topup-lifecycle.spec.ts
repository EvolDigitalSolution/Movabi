import {test,expect,type Page} from '@playwright/test';
import {installMovabiMocks,ids} from './fixtures/movabi-mocks';

// Driver top-up lifecycle in the Driver Hub Wallet tab. Stripe.js is replaced by a stub whose
// card is complete and whose confirmation SUCCEEDS (real Stripe cannot confirm a synthetic
// payment; the real-Stripe form is covered by driver-topup-continue-payment.spec.ts).
// Credit is only shown after the mocked server /verify returns a credited event id.
const attemptId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const quote={attemptId,walletAmountMinor:2000,feeMinor:100,totalChargeMinor:2100,currency:'GBP',exponent:2,feePolicyVersion:'vaydu-driver-card-5pct-wallet-v1',feeLabel:'Card fee (5%)',provider:'stripe'};
const SECRET='pi_3StubLifecycle0000000_secret_stubonly';
const STRIPE_STUB=`window.Stripe=function(){return{
  elements:function(){return{create:function(){var h={};return{
    mount:function(el){var i=document.createElement('input');i.setAttribute('aria-label','Stub card number');el.appendChild(i);
      setTimeout(function(){h.ready&&h.ready();h.change&&h.change({complete:true});},0);},
    on:function(n,f){h[n]=f;},unmount:function(){},destroy:function(){window.__stubCardDestroyed=(window.__stubCardDestroyed||0)+1;}};}};},
  confirmCardPayment:async function(){return{paymentIntent:{id:'pi_3StubLifecycle0000000',status:'succeeded'}};},
  handleNextAction:async function(){return{paymentIntent:{status:'succeeded'}};}};};`;

interface World {verify:number;resume:number;checkout:number;cashReads:number;availableMinor:string;}
async function setup(page:Page,opts:{verify:()=>{status:number;json:unknown},availability?:{status:number;json:unknown},pilotEnabled?:boolean,enrolled?:boolean}){
  const w:World={verify:0,resume:0,checkout:0,cashReads:0,availableMinor:'0'};
  await installMovabiMocks(page,'driver');
  await page.route('**/api/market-safety/**',route=>{
    const p=new URL(route.request().url()).pathname;
    if(p.endsWith('/driver-cash-credit')){w.cashReads++;return route.fulfill({json:{driverId:ids.driver,tenantId:ids.tenant,country:'GB',currency:'GBP',
      pilotEnabled:opts.pilotEnabled??false,enrolled:opts.enrolled??false,topupAvailable:false,payoutAvailable:false,acceptanceAuthority:'database',
      balance:{currency:'GBP',consistent:true,availableMinor:w.availableMinor,heldMinor:'0',deficitMinor:'0',eligibleDepositsMinor:w.availableMinor}}});}
    if(p.endsWith('/driver-cash-credit/activity'))return route.fulfill({json:{attempts:[]}});
    return route.fulfill({status:503,json:{code:'SYNTHETIC_UNAVAILABLE'}});
  });
  await page.route('**/api/booking/offer-metrics**',route=>route.fulfill({status:503,json:{code:'SYNTHETIC_UNAVAILABLE'}}));
  await page.route('**/api/payment/driver-topup/**',async route=>{
    const path=new URL(route.request().url()).pathname.split('/').pop()!;
    if(path==='availability')return route.fulfill(opts.availability??{json:{currency:'GBP',exponent:2}});
    const body=route.request().postDataJSON();
    if(path==='verify'){w.verify++;const r=opts.verify();if(r.status===200)w.availableMinor='2000';return route.fulfill(r);}
    if(path==='resume'){w.resume++;return route.fulfill({json:{attemptId,provider:'stripe',clientSecret:SECRET,nextAction:false}});}
    if(path==='checkout'){
      if(body.confirmedTotalMinor===undefined)return route.fulfill({json:{kind:'quote',...quote}});
      w.checkout++;return route.fulfill({json:{kind:'checkout',...quote,clientSecret:SECRET}});
    }
    return route.fulfill({status:404,json:{}});
  });
  await page.route(/^https:\/\/js\.stripe\.com\//,r=>r.fulfill({contentType:'application/javascript',body:STRIPE_STUB}));
  await page.goto('/auth/login');
  await page.getByLabel(/email address/i).fill('driver@movabi.test');
  await page.getByRole('textbox',{name:/^password$/i}).fill('Password123!');
  await page.getByRole('button',{name:/sign in/i}).click();
  await expect(page).toHaveURL(/\/driver/);
  await page.getByRole('button',{name:'Wallet',exact:true}).click();
  const card=page.getByRole('region',{name:'Cash-ride credit'}).or(page.locator('[aria-labelledby="cash-credit-title"]')).first();
  await expect(card).toContainText('Available cash-ride credit');
  return {w,card,panel:page.getByRole('region',{name:'Driver wallet credit'})};
}
async function payTwenty(page:Page,card:ReturnType<Page['locator']>,panel:ReturnType<Page['locator']>){
  await card.getByRole('button',{name:'Top up',exact:true}).click();
  await panel.getByRole('textbox').fill('20.00');
  await panel.getByRole('button',{name:'Review fee and total'}).click();
  await panel.getByRole('checkbox').check();
  await panel.getByRole('button',{name:'Continue to secure checkout'}).click();
  await expect(panel.getByLabel('Card details')).toBeVisible();
  await panel.getByRole('button',{name:/^Pay GBP 21\.00$/}).click();
}

test('successful top-up: credit confirmed by the server, panel closes and resets, balance refreshes, no second credit',async({page})=>{
  test.setTimeout(150_000);
  const {w,card,panel}=await setup(page,{verify:()=>({status:200,json:{creditedEventId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'}})});
  // Cash rides off in this market, but the top-up service allows top-ups: both stated, distinctly.
  await expect(card).toContainText('Cash rides are not enabled in GB yet');
  await expect(card).not.toContainText('Top-ups are unavailable');
  const readsBefore=w.cashReads;
  await payTwenty(page,card,panel);
  await expect(panel).toContainText('Payment verified. Wallet credit added.');
  expect(w.verify).toBe(1);
  // The form is gone: no card host, no amount field, nothing populated.
  await expect(panel.getByLabel('Card details')).toHaveCount(0);
  await expect(panel.getByRole('textbox')).toHaveCount(0);
  expect(await page.evaluate(()=>(window as any).__stubCardDestroyed)).toBe(1);
  expect(await page.evaluate(id=>localStorage.getItem('vaydu-driver-topup:'+id),ids.driver)).toBeNull();
  // Balance refreshed from the server immediately.
  await expect.poll(()=>w.cashReads).toBeGreaterThan(readsBefore);
  await expect(card).toContainText('GBP 20.00');
  // Reopening shows a clean form.
  await card.getByRole('button',{name:'Top up',exact:true}).click();
  await expect(panel.getByRole('textbox')).toHaveValue('');
  await expect(panel).not.toContainText('GBP 21.00');
  // Refresh and focus never verify (or credit) the completed attempt again.
  await page.reload();
  await page.getByRole('button',{name:'Wallet',exact:true}).click();
  await expect(card).toContainText('GBP 20.00');
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(1500);
  expect(w.verify).toBe(1);expect(w.checkout).toBe(1);
});

test('payment received but credit pending: attempt kept for reconciliation, stated accurately, then completes once',async({page})=>{
  test.setTimeout(150_000);
  let pending=true;
  const {w,card,panel}=await setup(page,{verify:()=>pending?{status:503,json:{code:'PAYMENT_RECEIVED_CREDIT_PENDING'}}:{status:200,json:{creditedEventId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'}}});
  await payTwenty(page,card,panel);
  await expect(panel).toContainText('Payment received. Your wallet credit is pending');
  await expect(panel.getByRole('button',{name:'Check payment status'})).toBeVisible();
  await expect(panel.getByRole('button',{name:'Continue payment'})).toHaveCount(0);
  await expect(panel.getByRole('button',{name:'Discard this unpaid attempt'})).toHaveCount(0);
  expect(await page.evaluate(id=>localStorage.getItem('vaydu-driver-topup:'+id),ids.driver)).toContain(attemptId);
  pending=false;
  await panel.getByRole('button',{name:'Check payment status'}).click();
  await expect(panel).toContainText('Payment verified. Wallet credit added.');
  await expect(panel.getByRole('textbox')).toHaveCount(0);
  await expect(card).toContainText('GBP 20.00');
  expect(w.checkout).toBe(1);
});

test('market states: top-up unavailable is shown from the top-up service; cash rides enabled from the cash status',async({page})=>{
  test.setTimeout(150_000);
  const {card}=await setup(page,{verify:()=>({status:409,json:{code:'PAYMENT_NOT_COMPLETED'}}),availability:{status:409,json:{code:'COLLECTION_DISABLED'}},pilotEnabled:true,enrolled:true});
  await expect(card).toContainText('Cash rides are enabled for you in GB');
  await expect(card).toContainText('Top-ups are unavailable right now.');
  await expect(card.getByRole('button',{name:'Top up',exact:true})).toHaveCount(0);
});
