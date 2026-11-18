// Behavioural check for the NG Kora customer-wallet collection adapter.
// Transpiles the real sources, injects a mock fetch + durable attempt store,
// and exercises: verified success, amount/currency/reference mismatch,
// duplicate verification, timeout reconciliation and exactly-once semantics.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const ts=createRequire(import.meta.url)('typescript');
const strip=s=>ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const root=new URL('../',import.meta.url),read=n=>readFileSync(new URL(n,root),'utf8');
const url=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64');
const load=(file)=>import(url(strip(read(file))
 .replace(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'\s*;/g,(m,names,key)=>key.startsWith('node:')?m:`const {${names}}=globalThis.__koraMocks[${JSON.stringify(key)}]||{};`)));

const contracts=await import(url(strip(read('server/services/payments/payment-contracts.ts'))));
globalThis.__koraMocks={'./payment-contracts':contracts,'./driver-card-topup-contracts':{}};
const koraSandboxModule=await load('server/services/payments/kora-sandbox.ts');
globalThis.__koraMocks['./kora-sandbox']=koraSandboxModule;
const adapterModule=await load('server/services/payments/kora-wallet-collection.ts');
const {KoraSandbox}=koraSandboxModule;
const {KoraWalletCollection}=adapterModule;
const {PaymentLayerError}=contracts;

const MERCHANT='kora_merchant_ng_test', KEY='sk_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REF='vaydu-topup-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const email='customer@example.com', redirectUrl='https://app.example.com/wallet/return';

// In-memory durable attempt store (same semantics as KoraDbAttempts).
const store=()=>{const rows=new Map();return{
 rows,
 async begin(reference,request){if(rows.has(reference))return false;rows.set(reference,{request,state:'started'});return true;},
 async finish(reference,state,checkoutUrl){if(!rows.has(reference))throw new PaymentLayerError('PAYMENT_RECONCILIATION_REQUIRED','missing attempt');const r=rows.get(reference);r.state=state;if(checkoutUrl)r.checkout_url=checkoutUrl;},
};};

// Response factories.
const ok=data=>({ok:true,json:async()=>({status:true,data})});
const initOk=(ref=REF,host='https://test-checkout.korapay.com')=>()=>Promise.resolve(ok({reference:ref,checkout_url:`${host}/pay/${ref}`}));
const verifyOk=(over={})=>()=>Promise.resolve(ok({reference:REF,currency:'NGN',status:'success',amount:'5000',amount_paid:'5000',...over}));
const input=(over={})=>({reference:REF,merchantAccountRef:MERCHANT,currency:'NGN',amountMinor:500000,exponent:2,
 providerAccountId:undefined,walletAmountMinor:500000,feeMinor:0,email,redirectUrl,...over});
const expected=(over={})=>({reference:REF,merchantAccountRef:MERCHANT,currency:'NGN',amountMinor:500000,...over});

const code=async fn=>{try{await fn();return null;}catch(e){return e.code||e.message;}};
let pass=0,fail=0;const check=(name,cond,detail='')=>{if(cond){pass++;console.log(`PASS ${name}`);}else{fail++;console.log(`FAIL ${name} ${detail}`);}};

// 1. Verified success: checkout then verify returns succeeded with exact terms.
{
 const s=store();const fetcher=async(u,o)=>o&&o.method==='POST'?initOk()():verifyOk()();
 const adapter=new KoraWalletCollection(new KoraSandbox(KEY,MERCHANT,s,fetcher),MERCHANT);
 await adapter.preflight(input());
 const co=await adapter.createCheckout(input());
 check('checkout binds the frozen reference',co.providerReference===REF,co.providerReference);
 check('checkout URL is the Kora test host',co.checkoutUrl.startsWith('https://test-checkout.korapay.com/'));
 check('attempt durably submitted',s.rows.get(REF).state==='submitted');
 const v=await adapter.verify(expected());
 check('verify returns succeeded',v.finalStatus==='succeeded'&&v.chargedAmountMinor===500000&&v.currency==='NGN'&&v.merchantAccountRef===MERCHANT&&v.reference===REF);
}

// 2. Verify success path end-to-end with provider GET.
{
 const s=store();const calls=[];
 const fetcher=async(u,o)=>{calls.push(u);return o&&o.method==='POST'?initOk()():verifyOk()();};
 const adapter=new KoraWalletCollection(new KoraSandbox(KEY,MERCHANT,s,fetcher),MERCHANT);
 await adapter.createCheckout(input());
 const v=await adapter.verify(expected());
 check('provider-verified success',v.finalStatus==='succeeded');
 check('verify queried the provider',calls.some(u=>u.endsWith('/charges/'+REF)));
}

// 3. Amount mismatch on verify -> unconfirmed, never 'succeeded'.
{
 const s=store();const adapter=new KoraWalletCollection(new KoraSandbox(KEY,MERCHANT,s,verifyOk({amount:'4999'})),MERCHANT);
 check('amount mismatch is unconfirmed',(await code(()=>adapter.verify(expected())))==='PAYMENT_RESPONSE_UNCONFIRMED');
}

// 4a. Currency mismatch (adapter-level non-NGN) -> route mismatch.
{
 const s=store();const adapter=new KoraWalletCollection(new KoraSandbox(KEY,MERCHANT,s,verifyOk()),MERCHANT);
 check('non-NGN input refused at preflight',(await code(()=>adapter.preflight(input({currency:'USD'}))))==='PAYMENT_ROUTE_MISMATCH');
}
// 4b. Currency mismatch in provider response -> unconfirmed.
{
 const s=store();const adapter=new KoraWalletCollection(new KoraSandbox(KEY,MERCHANT,s,verifyOk({currency:'USD'})),MERCHANT);
 check('provider currency mismatch is unconfirmed',(await code(()=>adapter.verify(expected())))==='PAYMENT_RESPONSE_UNCONFIRMED');
}

// 5. Reference mismatch: provider binds a different reference -> unconfirmed.
{
 const s=store();const adapter=new KoraWalletCollection(new KoraSandbox(KEY,MERCHANT,s,initOk('other-ref')),MERCHANT);
 check('checkout reference mismatch requires reconciliation',(await code(()=>adapter.createCheckout(input())))==='PAYMENT_RECONCILIATION_REQUIRED');
 check('mismatched submission marked unknown',s.rows.get(REF).state==='unknown');
}
{
 const s=store();const adapter=new KoraWalletCollection(new KoraSandbox(KEY,MERCHANT,s,verifyOk({reference:'other-ref'})),MERCHANT);
 check('verify reference mismatch is unconfirmed',(await code(()=>adapter.verify(expected())))==='PAYMENT_RESPONSE_UNCONFIRMED');
}

// 6. Timeout/uncertain submission -> durable 'unknown', non-retryable, verify unconfirmed.
{
 const s=store();const adapter=new KoraWalletCollection(new KoraSandbox(KEY,MERCHANT,s,()=>new Promise(()=>{})),MERCHANT);
 // fetch that never resolves -> AbortSignal.timeout(15000) fires; fake it with a rejecting fetch to keep the check fast.
 const timedOut=new KoraWalletCollection(new KoraSandbox(KEY,MERCHANT,s,()=>Promise.reject(new Error('aborted'))),MERCHANT);
 check('uncertain submission requires reconciliation',(await code(()=>timedOut.createCheckout(input())))==='PAYMENT_RECONCILIATION_REQUIRED');
 check('attempt marked unknown, not failed',s.rows.get(REF).state==='unknown');
 check('same reference cannot be re-submitted',(await code(()=>timedOut.createCheckout(input())))==='PAYMENT_RECONCILIATION_REQUIRED');
}

// 7. Duplicate verification returns identical frozen terms (exactly-once evidence;
//    the ledger credit itself is idempotent in confirm_wallet_topup_with_total).
{
 const s=store();const fetcher=async(u,o)=>o&&o.method==='POST'?initOk()():verifyOk()();
 const adapter=new KoraWalletCollection(new KoraSandbox(KEY,MERCHANT,s,fetcher),MERCHANT);
 await adapter.createCheckout(input());
 const v1=await adapter.verify(expected());
 const v2=await adapter.verify(expected());
 check('verify replay is deterministic',JSON.stringify(v1)===JSON.stringify(v2));
 check('attempt state unchanged by verify',s.rows.get(REF).state==='submitted');
}

// 8. Merchant binding mismatch is refused before any provider contact.
{
 const s=store();let contacted=false;
 const adapter=new KoraWalletCollection(new KoraSandbox(KEY,MERCHANT,s,async()=>{contacted=true;return ok({});}),MERCHANT);
 check('foreign merchant refused',(await code(()=>adapter.createCheckout(input({merchantAccountRef:'other'}))))==='PAYMENT_ROUTE_MISMATCH');
 check('refusal preceded provider contact',contacted===false);
}

// 9. Saved cards remain refused by the underlying client.
{
 const s=store();const sandbox=new KoraSandbox(KEY,MERCHANT,s,initOk());
 check('saved cards not installed',(await code(()=>sandbox.createCheckout({...expected(),email,redirectUrl,methods:['card'],saveForFuture:true})))==='PAYMENT_CAPABILITY_UNAVAILABLE');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
