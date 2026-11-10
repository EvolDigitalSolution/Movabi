const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),read=n=>fs.readFileSync(path.join(root,n),'utf8').replace(/\r\n/g,'\n');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const baseline=JSON.parse(read('scripts/driver-cash-credit-wallet-placement-baseline.json'));
const addition=read('scripts/cash-credit-ui-addition.html');
const dashboard=read('src/app/apps/mobile/features/driver/dashboard/dashboard.page.ts');
const earnings=read('src/app/apps/mobile/features/driver/earnings/earnings.page.ts');
const walletStart=dashboard.indexOf("} @else if (activeHubTab() === 'wallet') {");
const walletEnd=dashboard.indexOf("} @else if (activeHubTab() === 'profile') {",walletStart);
const position=dashboard.indexOf(addition);
assert.ok(walletStart>=0&&position>walletStart&&position+addition.length<walletEnd,'Cash credit must be inside Wallet only');
assert.equal(dashboard.split(addition).length,2,'Cash-credit section must appear exactly once');
let original=dashboard;
for(const part of [baseline.imports,baseline.bindings,addition+'\n']){
 assert.equal(original.split(part).length,2,'Unexpected source structure');original=original.replace(part,'');
}
assert.equal(original.split(baseline.newRefresh).length,2);
original=original.replace(baseline.newRefresh,baseline.oldRefresh);
assert.equal(hash(original),baseline.dashboard,'Existing dashboard layout or behavior changed');
assert.equal(hash(earnings),baseline.earnings,'Original Earnings page was not restored exactly');
assert.equal(earnings.includes('Cash-ride credit'),false);
console.log('BATCH1G_EXISTING_LAYOUT_AND_ACTIONS=PRESERVED (supplemental source check)');
console.log('CASH_CREDIT_PLACEMENT=WALLET_TAB_ONLY');
