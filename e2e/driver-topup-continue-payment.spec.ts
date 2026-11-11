import {test,expect,type Page,type Route} from '@playwright/test';
import {installMovabiMocks,ids} from './fixtures/movabi-mocks';

// Browser regression for the deployed driver top-up "Continue payment" journey.
// Unlike the shared fixture (which replaces Stripe.js with a stub whose mount() does nothing),
// REAL Stripe.js with the develop test-mode publishable key is loaded, so the card form must
// actually mount, accept input and report Stripe's own result. Only Vaydu's API is mocked.
// The client secret is synthetic: Stripe rejects it at confirmation, which is exactly the
// "non-card Stripe error" path that previously looped back to "Continue payment" silently.
const attemptId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const quote={attemptId,walletAmountMinor:2000,feeMinor:100,totalChargeMinor:2100,currency:'GBP',exponent:2,feePolicyVersion:'vaydu-driver-card-5pct-wallet-v1',feeLabel:'Card fee (5%)',provider:'stripe'};
const FAKE_SECRET='pi_3TestContinue000000000_secret_testonly';
const NOT_COMPLETED='This payment has not been completed and nothing has been charged.';

async function setup(page:Page,resumeBody:Record<string,unknown>){
  const errors:string[]=[];
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  page.on('pageerror',e=>errors.push(String(e)));
  await installMovabiMocks(page,'driver');
  await page.route('**/api/market-safety/**',route=>{
    const p=new URL(route.request().url()).pathname;
    if(p.endsWith('/driver-cash-credit'))return route.fulfill({json:{driverId:ids.driver,tenantId:ids.tenant,country:'GB',currency:'GBP',pilotEnabled:true,enrolled:true,
      topupAvailable:false,payoutAvailable:false,acceptanceAuthority:'database',
      balance:{currency:'GBP',consistent:true,availableMinor:'0',heldMinor:'0',deficitMinor:'0',eligibleDepositsMinor:'0'}}});
    if(p.endsWith('/driver-cash-credit/activity'))return route.fulfill({json:{attempts:[]}});
    return route.fulfill({status:503,json:{code:'SYNTHETIC_UNAVAILABLE'}});
  });
  await page.route('**/api/booking/offer-metrics**',route=>route.fulfill({status:503,json:{code:'SYNTHETIC_UNAVAILABLE'}}));
  const calls:string[]=[];const counts={checkout:0};
  await page.route('**/api/payment/driver-topup/**',async route=>{
    const path=new URL(route.request().url()).pathname.split('/').pop()!;calls.push(path);
    if(path==='availability')return route.fulfill({json:{currency:'GBP',exponent:2}});
    const body=route.request().postDataJSON();
    if(path==='verify')return route.fulfill({status:409,json:{code:'PAYMENT_NOT_COMPLETED'}});
    if(path==='resume'){expect(body).toEqual({attemptId});return route.fulfill({json:resumeBody});}
    if(path==='checkout'){
      if(body.confirmedTotalMinor===undefined)return route.fulfill({json:{kind:'quote',...quote}});
      counts.checkout++;return route.fulfill({json:{kind:'checkout',...quote,clientSecret:FAKE_SECRET}});
    }
    return route.fulfill({status:404,json:{}});
  });
  // Registered last so it wins over the fixture's Stripe stub: Stripe (and its hCaptcha) reach the network.
  await page.route(/^https:\/\/([a-z0-9-]+\.)*(stripe\.com|stripe\.network|hcaptcha\.com)\//,(r:Route)=>r.continue());
  await page.goto('/auth/login');
  await page.getByLabel(/email address/i).fill('driver@movabi.test');
  await page.getByRole('textbox',{name:/^password$/i}).fill('Password123!');
  await page.getByRole('button',{name:/sign in/i}).click();
  await expect(page).toHaveURL(/\/driver/);
  const panel=page.getByRole('region',{name:'Driver wallet credit'});
  const openWallet=async()=>{
    await page.getByRole('button',{name:'Wallet',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Cash-ride credit'})).toBeVisible();
  };
  // Start one top-up, leave the card form without paying, reload: the saved attempt is checked server-side.
  await openWallet();
  await page.getByRole('button',{name:'Top up',exact:true}).click();
  await panel.getByRole('textbox').fill('20.00');
  await panel.getByRole('button',{name:'Review fee and total'}).click();
  await expect(panel).toContainText('GBP 21.00');
  await panel.getByRole('checkbox').check();
  await panel.getByRole('button',{name:'Continue to secure checkout'}).click();
  await expect(panel.getByLabel('Card details')).toBeVisible();
  await page.reload();
  await openWallet();
  await expect(panel).toContainText(NOT_COMPLETED,{timeout:20_000});
  await panel.getByRole('button',{name:'Continue payment'}).click();
  return {panel,calls,counts,errors};
}

test('Continue payment reopens the SAME payment with a visible, usable Stripe card form; a Stripe rejection is shown, not looped',async({page})=>{
  test.setTimeout(150_000);
  const {panel,calls,counts,errors}=await setup(page,{attemptId,provider:'stripe',clientSecret:FAKE_SECRET,nextAction:false});
  const host=panel.getByLabel('Card details');
  await expect(host).toBeVisible();
  const frame=host.frameLocator('iframe').first();
  await expect(frame.locator('input[name="cardnumber"]')).toBeVisible({timeout:30_000});
  await frame.locator('input[name="cardnumber"]').fill('4242424242424242');
  await frame.locator('input[name="exp-date"]').fill('1234');
  await frame.locator('input[name="cvc"]').fill('123');
  const pay=panel.getByRole('button',{name:/^Pay GBP 21\.00$/});
  await expect(pay).toBeEnabled();
  expect(calls.filter(c=>c==='resume')).toHaveLength(1);
  expect(counts.checkout).toBe(1); // the same attempt; no replacement payment
  // Stripe rejects the synthetic secret (not a card error). Before the fix the form vanished and the
  // screen returned to the same "not completed" text with no reason. Now Stripe's reason is shown.
  await pay.click();
  const status=panel.getByRole('status').first();
  await expect(status).toContainText(NOT_COMPLETED,{timeout:30_000});
  const text=(await status.innerText()).trim();
  console.log('[driver-topup] status after Stripe rejection: '+text);
  expect(text.startsWith(NOT_COMPLETED)).toBe(false);
  expect(text).not.toContain(FAKE_SECRET);
  expect(errors.filter(e=>/IntegrationError|mount/i.test(e))).toEqual([]);
});

test('a resume response for another provider never opens the Stripe form',async({page})=>{
  test.setTimeout(150_000);
  const {panel,calls}=await setup(page,{attemptId,provider:'kora',clientSecret:'opaque-provider-token',nextAction:false});
  await expect(panel).toContainText('could not be reopened safely',{timeout:15_000});
  await expect(panel.getByLabel('Card details')).toHaveCount(0);
  expect(calls.filter(c=>c==='resume')).toHaveLength(1);
});
