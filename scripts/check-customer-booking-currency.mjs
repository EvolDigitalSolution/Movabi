import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const root=new URL('../',import.meta.url),read=n=>readFileSync(new URL(n,root),'utf8');
const money=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(read('src/app/shared/utils/wallet-recorded-money.ts'))).toString('base64'));
let count=0;
for(const [file,method,expected] of [['activity/activity.page.ts','formatPrice',3],['home.page.ts','formatCurrency',1]]){
 const s=read('src/app/apps/mobile/features/customer/'+file),code=stripTypeScriptTypes(s);
 const match=new RegExp(method+'\\(amount[^)]*\\)\\s*\\{([\\s\\S]*?)\\n    \\}').exec(code);assert.ok(match,file);
 const fn=new Function('recordedWalletAmount','return function(amount,currencyCode){'+match[1]+'}')(money.recordedWalletAmount);
 for(const [amount,currency,result] of [[4116.63,'NGN','NGN 4,116.63'],[5051.97,'NGN','NGN 5,051.97'],[12.5,'GBP','GBP 12.50'],[10,'USD','USD 10.00'],[0,'NGN','NGN 0.00'],[10,undefined,'Currency unavailable'],[NaN,'NGN','Amount unavailable']]){
  assert.equal(fn.call({config:{formatCurrency(){throw Error('Display preference must not be used');}}},amount,currency),result);count++;
 }
 const bindings=[...s.matchAll(new RegExp('\\{\\{\\s*'+method+'\\((booking\\.[^)]*)\\)\\s*\\}\\}','g'))];
 assert.equal(bindings.length,expected,file);
 assert.ok(bindings.every(x=>x[1].endsWith(', booking.currency_code')),file);
 console.log('PASS explicit recorded currency: '+file);
}
console.log(`CUSTOMER_BOOKING_CURRENCY_RUNTIME=${count}_PASSED`);
