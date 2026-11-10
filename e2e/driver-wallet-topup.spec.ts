import {test,expect} from '@playwright/test';
import {installMovabiMocks} from './fixtures/movabi-mocks';
for(const provider of ['flutterwave','stripe'] as const){
test('Driver Hub '+provider+' preserves quote and attempt; return requires server credit confirmation',async({page})=>{
 await installMovabiMocks(page,'driver');
 await page.route('**/api/market-safety/**',route=>route.fulfill({status:503,json:{code:'SYNTHETIC_UNAVAILABLE'}}));
 await page.goto('/auth/login');
 await page.getByLabel(/email address/i).fill('driver@movabi.test');
 await page.getByRole('textbox',{name:/^password$/i}).fill('Password123!');
 await page.getByRole('button',{name:/sign in/i}).click();
 await expect(page).toHaveURL(/\/driver/);
 const currency=provider==='stripe'?'GBP':'KWD',exponent=provider==='stripe'?2:3;
 const finalText=currency+(exponent===2?' 12.96':' 1.296');
 const checkoutUrl=provider==='stripe'?'https://checkout.stripe.com/c/pay/cs_test_synthetic':'https://checkout.flutterwave.com/test';
 const keys:string[]=[];let verified=false;let submits=0;
 const quote={attemptId:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',walletAmountMinor:1234,feeMinor:62,totalChargeMinor:1296,currency,exponent,feePolicyVersion:'vaydu-driver-card-5pct-wallet-v1',feeLabel:'Vaydu fee (5%)',provider};
 await page.route('**/api/payment/driver-topup/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.endsWith('/availability'))return route.fulfill({json:{currency,exponent}});
  const body=route.request().postDataJSON();
  if(path.endsWith('/verify'))return route.fulfill(verified?{json:{creditedEventId:'cccccccc-cccc-cccc-cccc-cccccccccccc'}}:{status:409,json:{code:'PAYMENT_RESPONSE_UNCONFIRMED'}});
  keys.push(body.idempotencyKey);
  if(body.confirmedTotalMinor!==undefined){submits++;expect(body.confirmedTotalMinor).toBe(1296);return route.fulfill({json:{kind:'checkout',...quote,checkoutUrl}});}
  return route.fulfill({json:{kind:'quote',...quote}});
 });
 await page.route(checkoutUrl,route=>route.fulfill({contentType:'text/html',body:'<p>Synthetic checkout</p>'}));
 await page.getByRole('button',{name:'Wallet',exact:true}).click();
 const panel=page.getByRole('region',{name:'Add driver wallet credit'});
 await panel.getByRole('textbox').fill(exponent===2?'12.34':'1.234');
 await panel.getByRole('button',{name:'Review fee and total'}).click();
 await expect(panel).toContainText(finalText);
 await expect(panel).toContainText('Vaydu fee (5%)');
 await expect(panel.getByRole('button',{name:'Continue to secure checkout'})).toBeDisabled();
 await page.reload();
 await page.getByRole('button',{name:'Wallet',exact:true}).click();
 await expect(panel).toContainText(finalText);
 await panel.getByRole('checkbox').check();
 await panel.getByRole('button',{name:'Continue to secure checkout'}).click();
 await expect(page).toHaveURL(checkoutUrl);
 await page.goto('/driver-topup-return?status=successful&tx_ref=untrusted');
 await expect(page.getByRole('link',{name:'Return to Vaydu app'})).toHaveAttribute('href','com.movabi.app://driver?topupReturn=1');
 await page.getByRole('link',{name:'Continue in this browser'}).click();
 await expect(panel.getByRole('button',{name:'Check payment status'})).toBeVisible();
 await expect(panel).not.toContainText('Wallet credit added');
 verified=true;
 await panel.getByRole('button',{name:'Check payment status'}).click();
 await expect(panel).toContainText('Payment verified. Wallet credit added.');
 expect(new Set(keys).size).toBe(1);expect(submits).toBe(1);
});
}
