import {expect,test,type Page} from '@playwright/test';
import {loginAs,lastBookingCreateBody,setWalletBalance,profiles,REGISTRATION_ACTIVATED} from './fixtures/movabi-mocks';
let observedErrors:string[]=[];
test.afterEach(async({},info)=>{await info.attach('browser-errors',{body:JSON.stringify(observedErrors,null,2),contentType:'application/json'});});

async function bookingFixture(page:Page,balance=0.5){
 const errors:string[]=[];
 observedErrors=errors;
 page.on('pageerror',e=>errors.push(e.message));
 page.on('console',m=>{if(m.type()==='error'&&/NG\d+|Cannot find control|_rawValidators|formGroup|formControl|No value accessor/i.test(m.text()))errors.push(m.text());});
 setWalletBalance(balance);
 await loginAs(page,'customer');
 await page.route('**/api/payment/card-wallet',r=>r.fulfill({json:{cards:[],canAdd:true,consentVersion:'saved-card-on-session-v1'}}));
 await page.route('**/api/booking/early-stop/**',r=>r.fulfill({status:404,json:{code:'EARLY_STOP_DISABLED'}}));
 await page.route('**/api/booking/cash/availability',r=>r.fulfill({json:{available:true,holdAmountMinor:500,currency:'GBP',provider:'stripe',noShowFeeMinor:175,lateCancelFeeMinor:500}}));
 await page.route(/^https:\/\/js\.stripe\.com\//,r=>r.fulfill({contentType:'application/javascript',body:`window.Stripe=function(){return{elements:function(){return{create:function(){var h={};var el;return{mount:function(e){el=e;var i=document.createElement('input');i.setAttribute('aria-label','Test card input');el.appendChild(i);setTimeout(function(){h.ready&&h.ready();h.change&&h.change({complete:true});},0);},on:function(n,f){h[n]=f;},unmount:function(){if(el)el.replaceChildren();},destroy:function(){if(el)el.replaceChildren();}};}};},confirmCardPayment:async function(){return{paymentIntent:{id:'pi_test',status:'requires_capture'}};}};};`}));
 const places=[{label:'Back Skipton Street, Bolton, United Kingdom',lat:53.590,lng:-2.429,countryCode:'GB'},
 {label:'Tonge Moor Primary Academy, Bolton, United Kingdom',lat:53.5985,lng:-2.4155,countryCode:'GB'}];
 await page.route('**/api/maps-v23/**',async r=>{
  const op=new URL(r.request().url()).pathname.split('/').pop();const b=r.request().method()==='POST'?(r.request().postDataJSON()||{}):{};
  if(op==='configuration')return r.fulfill({json:{search:true,routing:true}});
  if(op==='search')return r.fulfill({json:{attribution:'test',results:places.filter(p=>String(b.query||'').toLowerCase().includes(p.label.startsWith('Back')?'skipton':'tonge'))}});
  if(op==='reverse')return r.fulfill({json:{label:places[0].label,countryCode:'GB'}});
  if(op==='route'){const s=b.start,e=b.end;return r.fulfill({json:{coordinates:[[s.lng,s.lat],[e.lng,e.lat]],steps:[],distanceMeters:1800,durationSeconds:360,geometry:{type:'LineString',coordinates:[[s.lng,s.lat],[e.lng,e.lat]]},bounds:[[Math.min(s.lng,e.lng),Math.min(s.lat,e.lat)],[Math.max(s.lng,e.lng),Math.max(s.lat,e.lat)]]}});}
  return r.fulfill({status:404,json:{error:'Unknown map fixture operation'}});
 });
 return errors;
}
async function addresses(page:Page){
 const manual=page.getByRole('button',{name:/continue with manual address/i});if(await manual.isVisible().catch(()=>false))await manual.click();
 await page.getByRole('textbox',{name:/pickup address/i}).fill('Back Skipton Street, Bolton');
 await page.getByRole('button',{name:/Back Skipton Street/i}).first().click();
 await page.getByRole('textbox',{name:/where should we deliver/i}).fill('Tonge Moor Primary Academy, Bolton');
 await page.getByRole('button',{name:/Tonge Moor Primary Academy/i}).first().click();
}
test('quote renders discount and payment controls without breaking the reactive form',async({page})=>{
 const errors=await bookingFixture(page);
 await page.getByRole('button',{name:/book a ride/i}).click();await addresses(page);
 await expect(page.getByPlaceholder('Discount code')).toBeVisible();
 await expect(page.getByRole('radio',{name:'Pay the driver in cash',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:/request & pay by card/i})).toBeEnabled();
 expect(errors).toEqual([]);
 await page.getByPlaceholder('Discount code').fill('EXAMPLE');
 await expect(page.getByRole('button',{name:'Apply',exact:true})).toBeEnabled();
 expect(lastBookingCreateBody).toBeNull();
 await page.getByRole('button',{name:/request & pay by card/i}).click();
 await expect(page).toHaveURL(/\/customer\/tracking\/booking-test/);
 expect((lastBookingCreateBody?.['booking'] as any).currency_code).toBe('GBP');
 expect(errors).toEqual([]);
});

test('card/cash/wallet views remount and retain usable validation and submission',async({page})=>{
 const errors=await bookingFixture(page,42.5);
 await page.getByRole('button',{name:/book a ride/i}).click();await addresses(page);
 const card=page.getByRole('radio',{name:'Card',exact:true}),cash=page.getByRole('radio',{name:'Pay the driver in cash',exact:true});
 for(let i=0;i<3;i++){
  await cash.check();await expect(page.getByRole('button',{name:/request cash ride/i})).toBeEnabled();
  await card.check();await expect(page.getByRole('button',{name:/request & pay by card/i})).toBeEnabled();
  await page.getByRole('radio',{name:'Use existing wallet credit',exact:true}).check();
  await expect(page.getByRole('textbox',{name:'Test card input'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:/request with wallet/i})).toBeEnabled();
  await card.check();await expect(page.getByRole('textbox',{name:'Test card input'})).toHaveCount(1);
  await expect(page.getByRole('button',{name:/request & pay by card/i})).toBeEnabled();
 }
 await page.getByRole('button',{name:/request & pay by card/i}).click();await expect(page).toHaveURL(/\/customer\/tracking\/booking-test/);expect(errors).toEqual([]);
});

test('delayed quote cannot restore controls after address clearing; next route still submits',async({page})=>{
 const errors=await bookingFixture(page);
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);let started=0;
 await page.route('**/api/pricing/global-ai/quote',async r=>{started++;if(started===1)await gate;await r.fallback();});
 await page.getByRole('button',{name:/book a ride/i}).click();await addresses(page);
 await expect.poll(()=>started).toBe(1);
 await page.getByRole('button',{name:'Clear drop-off address',exact:true}).click();
 const oldResponse=page.waitForResponse(r=>r.url().includes('/api/pricing/global-ai/quote'));release();await oldResponse;
 await expect(page.getByPlaceholder('Discount code')).toHaveCount(0);
 await expect(page.getByRole('button',{name:/request & pay by card/i})).toBeDisabled();
 await page.getByRole('textbox',{name:/where should we deliver/i}).fill('Tonge Moor Primary Academy, Bolton');
 await page.getByRole('button',{name:/Tonge Moor Primary Academy/i}).first().click();
 await expect(page.getByRole('button',{name:/request & pay by card/i})).toBeEnabled();
 await page.getByRole('button',{name:/request & pay by card/i}).click();await expect(page).toHaveURL(/\/customer\/tracking\/booking-test/);expect(errors).toEqual([]);
});

test('service route changes and away/back retire old controls without losing validation',async({page})=>{
 const errors=await bookingFixture(page);
 for(const service of ['Open Delivery services','Open Shop services','Open Move services']){
  await page.getByRole('button',{name:service,exact:true}).click();await expect(page).toHaveURL(/\/customer\/request/);
  await expect(page.getByRole('button',{name:/request/i}).last()).toBeDisabled();
  if(service==='Open Shop services'){
   await page.locator('form').getByRole('button',{name:/^shop & deliver$/i}).click();
   await page.getByRole('textbox',{name:/items to buy/i}).fill('Milk');
   await page.locator('form').getByRole('button',{name:/^collect & deliver$/i}).click();
  }
  await page.getByRole('button',{name:'back',exact:true}).click();await expect(page).toHaveURL(/\/customer(?:\?.*)?$/);
 }
 await page.getByRole('button',{name:/book a ride/i}).click();await addresses(page);
 await expect(page.getByRole('button',{name:/request & pay by card/i})).toBeEnabled();
 await page.getByRole('button',{name:'back',exact:true}).click();await expect(page).toHaveURL(/\/customer(?:\?.*)?$/);
 await page.getByRole('button',{name:/book a ride/i}).click();
 await expect(page).toHaveURL(/\/customer\/request/);
 // A preserved draft or a fresh Ionic view are both valid, but no stale service-only control may remain.
 await expect(page.locator('[formControlName="recipient_phone"]')).toHaveCount(0);
 if(!await page.getByPlaceholder('Discount code').isVisible())await addresses(page);
 await expect(page.getByRole('button',{name:/request & pay by card/i})).toBeEnabled();
 await page.getByRole('button',{name:/request & pay by card/i}).click();await expect(page).toHaveURL(/\/customer\/tracking\/booking-test/);expect(errors).toEqual([]);
});

test('NG registration with saved GBP preference can book GB using the quoted service market',async({page})=>{
 const errors=await bookingFixture(page);
 await page.route('**/rest/v1/profiles*',r=>r.fulfill({json:{...profiles.customer,country_code:'NG',registration_country_code:'NG',currency_code:'GBP'}}));
 await page.route('**/api/markets/registration-*',r=>r.fulfill({json:{...REGISTRATION_ACTIVATED,registrationCountryCode:'NG'}}));
 await page.reload();
 await page.getByRole('button',{name:/book a ride/i}).click();await addresses(page);
 await expect(page.getByRole('button',{name:/request & pay by card/i})).toBeEnabled();
 await page.getByRole('button',{name:/request & pay by card/i}).click();await expect(page).toHaveURL(/\/customer\/tracking\/booking-test/);
 expect(lastBookingCreateBody?.['booking']).toMatchObject({country_code:'GB',currency_code:'GBP'});expect(errors).toEqual([]);
});

test('GB customer receiving an NG/NGN service quote never receives GB Stripe controls or GBP wallet credit',async({page})=>{
 const errors=await bookingFixture(page,42.5);
 let created=0;page.on('request',r=>{if(new URL(r.url()).pathname==='/api/booking/create')created++;});
 await page.route('**/api/pricing/global-ai/quote',r=>r.fulfill({json:{quoteReference:'quote-ng-scope',market:{countryCode:'NG',currency:'NGN',city:'Lagos'},price:{base:100},ai:{livePricingEnabled:false,finalTotalMinor:10000},guardrails:{},priceLockedUntil:new Date(Date.now()+1800000).toISOString(),fallback:{used:false},legacy:{totalPrice:100,currencyCode:'NGN',fareBreakdown:{baseFare:100,total:100,currencyCode:'NGN',currencySymbol:'₦'}}}}));
 await page.getByRole('button',{name:/book a ride/i}).click();await addresses(page);
 await expect(page.getByText(/Payment setup for this journey market is not ready yet/)).toBeVisible();
 await expect(page.getByRole('textbox',{name:'Test card input'})).toHaveCount(0);
 await expect(page.getByRole('radio',{name:'Use existing wallet credit',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:/request & pay by card/i})).toBeDisabled();expect(created).toBe(0);expect(errors).toEqual([]);
});

for(const scenario of ['missing-route','disabled-feature','unsupported-ng','gb-ready'] as const){
 test(`saved-card screen distinguishes ${scenario}`,async({page})=>{
  const errors=await bookingFixture(page);
  await page.route('**/api/payment/card-wallet',r=>r.fulfill(scenario==='missing-route'?{status:404,contentType:'text/html',body:'Cannot GET /api/payment/card-wallet'}:
   scenario==='disabled-feature'?{status:404,json:{code:'SAVED_CARDS_DISABLED',error:'Saved-card management is currently disabled.'}}:
   {json:{cards:[],canAdd:scenario==='gb-ready',reasonCode:scenario==='unsupported-ng'?'CARD_SETUP_MARKET_UNSUPPORTED':null,consentVersion:'save-card-on-session-setup-v1'}}));
  await page.goto('/customer/payment-methods');
  if(scenario==='missing-route'){
   await expect(page.getByRole('alert')).toContainText('could not be loaded');await expect(page.getByRole('button',{name:'Retry loading'})).toBeVisible();
   await expect(page.getByText(/not supported for your registration market/)).toHaveCount(0);
  }else if(scenario==='disabled-feature')await expect(page.getByRole('alert')).toContainText('currently disabled');
  else if(scenario==='unsupported-ng'){await expect(page.getByText(/not supported for your registration market/)).toBeVisible();await expect(page.getByRole('button',{name:'Add a card',exact:true})).toHaveCount(0);}
  else await expect(page.getByRole('button',{name:'Add a card',exact:true})).toBeVisible();
  expect(errors).toEqual([]);
 });
}

test('cash selection survives create and uses only the separate fee-hold path',async({page})=>{
 const errors=await bookingFixture(page);const calls:Array<{path:string;body:any}>=[];
 await page.route('**/api/booking/cash/booking-test/**',async r=>{
  const path=new URL(r.request().url()).pathname;calls.push({path,body:r.request().postDataJSON()});
  return r.fulfill({json:path.endsWith('/confirm')?{success:true,result:'activated',booking:{id:'booking-test',status:'searching',payment_method:'cash',payment_status:'cash_due'}}:
   {jobId:'booking-test',provider:'stripe',clientSecret:'pi_cash_hold_secret_fixture',amountMinor:500,currency:'GBP'}});
 });
 let fullFareIntents=0;page.on('request',r=>{if(new URL(r.url()).pathname==='/api/payment/create-intent')fullFareIntents++;});
 await page.getByRole('button',{name:/book a ride/i}).click();await addresses(page);
 await page.getByRole('radio',{name:'Pay the driver in cash',exact:true}).check();
 await expect(page.getByRole('note',{name:'Cash payment terms'})).toContainText('Your card is not charged for the ride');
 await expect(page.getByRole('button',{name:/request cash ride/i})).toBeEnabled();
 await page.getByRole('button',{name:/request cash ride/i}).click();await expect(page).toHaveURL(/\/customer\/tracking\/booking-test/);
 expect((lastBookingCreateBody?.['booking'] as any).metadata.payment_choice).toBe('cash');
 expect(calls.map(c=>c.path)).toEqual(['/api/booking/cash/booking-test/fee-hold','/api/booking/cash/booking-test/fee-hold/confirm']);
 expect(fullFareIntents).toBe(0);expect(errors).toEqual([]);
});

test('ineligible cash displays the exact server reason and card remains usable',async({page})=>{
 const errors=await bookingFixture(page);
 await page.route('**/api/booking/cash/availability',r=>r.fulfill({json:{available:false,code:'CASH_FEE_TERMS_UNAVAILABLE',reason:'No fee terms apply, so a cash ride cannot be secured'}}));
 await page.getByRole('button',{name:/book a ride/i}).click();await addresses(page);
 await expect(page.getByTestId('cash-unavailable-reason')).toHaveText('No fee terms apply, so a cash ride cannot be secured');
 await expect(page.getByRole('radio',{name:'Pay the driver in cash',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:/request & pay by card/i})).toBeEnabled();expect(errors).toEqual([]);
});

test('admin shows saved NG/GBP profile context without converting payment records',async({page})=>{
 const errors:string[]=[];observedErrors=errors;page.on('pageerror',e=>errors.push(e.message));
 await loginAs(page,'admin');
 await page.route('**/api/admin/users',r=>r.fulfill({json:[{...profiles.customer,country_code:'NG',registration_country_code:' ',currency_code:'GBP'}]}));
 await page.goto('/admin/users');await page.getByRole('button',{name:/View details for Test Customer/i}).click();
 const details=page.locator('ion-modal').filter({has:page.getByText('Saved profile currency',{exact:true})});
 await expect(details).toContainText('Registration country');await expect(details).toContainText('NG');
 await expect(details).toContainText('Saved profile currency');await expect(details).toContainText('GBP');
 await expect(details).toContainText('Booking currency and payment provider follow the service market');expect(errors).toEqual([]);
});
