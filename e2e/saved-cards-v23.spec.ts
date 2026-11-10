import {expect,test,Page} from '@playwright/test';
import {loginAs} from './fixtures/movabi-mocks';
async function openCheckout(page:Page, quoteCurrency='GBP') {
  await loginAs(page,'customer');
  let cards=[{id:'pm_owned',brand:'visa',last4:'4242',expMonth:12,expYear:2030}];
  await page.route('**/api/payment/cards',route=>route.fulfill({json:{enabled:true,cards}}));
  await page.route('**/api/payment/cards/pm_owned',route=>{cards=[];return route.fulfill({json:{success:true}});});
  if(quoteCurrency==='NGN') await page.route('**/api/pricing/global-ai/quote',route=>route.fulfill({json:{
    quoteReference:'quote-ngn-test',market:{countryCode:'NG',currency:'NGN',city:'Lagos',zoneId:null},
    price:{base:100},ai:{livePricingEnabled:false,finalTotalMinor:10000},guardrails:{},
    priceLockedUntil:new Date(Date.now()+1800000).toISOString(),fallback:{used:false,reason:null,source:'mock'},
    legacy:{totalPrice:100,currencyCode:'NGN',source:'mock',fareBreakdown:{baseFare:100,distanceCost:0,durationCost:0,serviceFee:0,total:100,currencyCode:'NGN',currencySymbol:'₦'}}
  }}));
  await page.getByRole('button',{name:/book a ride/i}).click();
  const manual=page.getByRole('button',{name:/continue with manual address/i});
  if(await manual.isVisible().catch(()=>false))await manual.click();
  await page.getByRole('textbox',{name:/pickup address/i}).fill('Back Skipton Street, Bolton');
  await page.getByRole('button',{name:/Back Skipton Street/i}).first().click();
  await page.getByRole('textbox',{name:/where should we deliver/i}).fill('Tonge Moor Primary Academy, Bolton');
  await page.getByRole('button',{name:/Tonge Moor Primary Academy/i}).first().click();
}
test('saving a card is optional and unchecked; an incomplete new card cannot submit',async({page})=>{
  await openCheckout(page);
  const save=page.getByRole('checkbox',{name:'Save this card for future payments'});
  await expect(save).toBeVisible();await expect(save).not.toBeChecked();
  await save.check();await expect(save).toBeChecked();
  await save.uncheck();await expect(save).not.toBeChecked();
  await expect(page.getByRole('button',{name:/request & pay by card/i})).toBeDisabled();
});
test('customer can explicitly select a masked saved card and remove it',async({page})=>{
  await openCheckout(page);
  await page.getByRole('radio',{name:/visa ending 4242/i}).check();
  await expect(page.getByRole('button',{name:/request & pay by card/i})).toBeEnabled();
  await expect(page.getByRole('checkbox',{name:'Save this card for future payments'})).toHaveCount(0);
  await page.getByRole('button',{name:'Remove card ending 4242'}).click();
  await expect(page.getByRole('radio',{name:/visa ending 4242/i})).toHaveCount(0);
  await expect(page.getByRole('radio',{name:'Use a new card'})).toBeChecked();
  await expect(page.getByRole('button',{name:/request & pay by card/i})).toBeDisabled();
});

test('server NGN quote controls display and cannot use a GBP wallet',async({page})=>{
  await openCheckout(page,'NGN');
  await expect(page.getByText(/(?:NGN|₦)\s*100\.00/).first()).toBeVisible();
  await expect(page.getByRole('radio',{name:'Use existing wallet credit'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:/request & pay by card/i})).toBeDisabled();
});
