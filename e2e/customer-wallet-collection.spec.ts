import {test,expect,type Page} from '@playwright/test';
import {loginAs,ids} from './fixtures/movabi-mocks';

// Customer wallet top-up through the real UI -> /api/wallet/collection/* ->
// Stripe.js (stubbed; real Stripe sandbox requires live keys, covered by the
// driver card collection path using the same adapter). The quote is frozen by
// the server; the page submits the confirmed total, confirms the card, then
// asks the server to verify — matching the real GBP collection semantics.
const attemptId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const STRIPE_STUB=`window.Stripe=function(){return{
  elements:function(){return{create:function(){var h={};return{
    mount:function(el){var i=document.createElement('input');i.setAttribute('aria-label','Stub card number');el.appendChild(i);
      setTimeout(function(){h.ready&&h.ready();h.change&&h.change({complete:true});},0);},
    on:function(n,f){h[n]=f;},unmount:function(){},destroy:function(){}};}};},
  confirmCardPayment:async function(){return{paymentIntent:{id:'pi_cust_stub',status:'succeeded'}};}}};`;

interface World{quote:number;checkout:number;verify:number;}
async function setup(page:Page){
  const w:World={quote:0,checkout:0,verify:0};
  await loginAs(page,'customer');
  await page.route('**/api/booking/debts',r=>r.fulfill({json:[]}));
  await page.route('**/api/booking/referrals/**',r=>r.fulfill({json:{available:false}}));
  await page.route('**/api/wallet/sandbox-topups/eligibility',r=>r.fulfill({json:{eligible:false}}));
  await page.route('**/api/wallet/topup-readiness',r=>r.fulfill({json:{
    collectionAvailable:true,canSubmit:true,reason:'available',country:'GB',currency:'GBP',
    collectionEnabled:true,maxAmountMinor:'1000000',providers:[{provider:'stripe',routeReady:true,reasons:[]}],blockers:[]}}));
  await page.route('**/api/wallet/collection/checkout',r=>{
    const body=r.request().postDataJSON() as {confirmedTotalMinor?:number};
    if(body.confirmedTotalMinor===undefined){w.quote++;return r.fulfill({json:{
      kind:'quote',attemptId,walletAmountMinor:2000,feeMinor:0,totalChargeMinor:2000,currency:'GBP',
      exponent:2,feePolicyVersion:'vaydu-customer-card-0fee-test-v1',feeLabel:'No card fee',provider:'stripe'}});}
    w.checkout++;return r.fulfill({json:{kind:'checkout',attemptId,walletAmountMinor:2000,feeMinor:0,
      totalChargeMinor:2000,currency:'GBP',exponent:2,feePolicyVersion:'vaydu-customer-card-0fee-test-v1',
      feeLabel:'No card fee',provider:'stripe',clientSecret:'pi_cust_stub_secret'}});
  });
  await page.route('**/api/wallet/collection/verify',r=>{w.verify++;return r.fulfill({json:{creditedEventId:'33333333-3333-4333-8333-333333333333'}});});
  await page.addInitScript(STRIPE_STUB);
  await page.goto('/customer/wallet');
  return w;
}

test.describe('customer wallet top-up',()=>{
  test('top-up through the UI: quote -> card confirm -> verify credits the wallet',async({page})=>{
    const w=await setup(page);
    await expect(page.getByRole('heading',{name:'Top up wallet'})).toBeVisible();
    await page.getByRole('button',{name:'£20'}).click();
    await page.getByRole('button',{name:'Top up wallet'}).click();
    // Frozen quote is displayed for confirmation before any charge.
    await expect(page.getByText('Wallet credit')).toBeVisible();
    await expect(page.getByText('Charged to card')).toBeVisible();
    await page.getByRole('button',{name:'Confirm and pay'}).click();
    await expect(page.getByText('Wallet topped up successfully')).toBeVisible({timeout:15000});
    expect(w.quote).toBe(1);expect(w.checkout).toBe(1);expect(w.verify).toBe(1);
  });

  test('top-up is hidden when collection is unavailable',async({page})=>{
    await loginAs(page,'customer');
    await page.route('**/api/booking/debts',r=>r.fulfill({json:[]}));
  await page.route('**/api/booking/referrals/**',r=>r.fulfill({json:{available:false}}));
    await page.route('**/api/wallet/sandbox-topups/eligibility',r=>r.fulfill({json:{eligible:false}}));
    await page.route('**/api/wallet/topup-readiness',r=>r.fulfill({json:{
      collectionAvailable:false,canSubmit:false,reason:'collection_disabled',blockers:['collection_disabled']}}));
    await page.goto('/customer/wallet');
    await expect(page.getByRole('heading',{name:'Top up wallet'})).toHaveCount(0);
    await expect(page.getByText(/not available for your account/)).toBeVisible();
  });
});
