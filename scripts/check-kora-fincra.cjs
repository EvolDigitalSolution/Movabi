/* Offline contract checks. Node 24+, no dependencies or credentials required.
 * Run: node --experimental-vm-modules scripts/check-kora-fincra.cjs */
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const assert=require('node:assert/strict');
const {createHmac}=require('node:crypto');
const root=path.resolve(__dirname,'..');
const modules=new Map();
async function load(file){
 if(modules.has(file))return modules.get(file);
 if(file.startsWith('node:')){
  const value=require(file), names=Object.keys(value);
  const m=new vm.SyntheticModule(names,function(){for(const key of names)this.setExport(key,value[key]);});
  modules.set(file,m);await m.link(()=>{});await m.evaluate();return m;
 }
 const source=stripTypeScriptTypes(fs.readFileSync(file,'utf8'),{mode:'transform',sourceUrl:file});
 const m=new vm.SourceTextModule(source,{identifier:file});modules.set(file,m);
 await m.link((specifier,parent)=>load(specifier.startsWith('node:')?specifier:path.resolve(path.dirname(parent.identifier),specifier+'.ts')));
 await m.evaluate();return m;
}
(async()=>{
 const {KoraSandbox,KoraDbAttempts,koraNgnMinor}=(await load(path.join(root,'server/services/payments/kora-sandbox.ts'))).namespace;
 const {paymentPolicies}=(await load(path.join(root,'server/services/payments/market-payment-registry.ts'))).namespace;
 const {PaymentGateway}=(await load(path.join(root,'server/services/payments/payment-gateway.ts'))).namespace;
 const {FINCRA_STATUS,requireFincraReady}=(await load(path.join(root,'server/services/payments/fincra-pending.ts'))).namespace;
 const {AFRICAN_PAYMENT_CANDIDATES}=(await load(path.join(root,'server/services/payments/payment-market-catalog.ts'))).namespace;
 let passed=0;
 async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
 const key='sk_test_offline_fixture';
 const expected={reference:'vaydu-test-reference',merchantAccountRef:'kora-sandbox-eds',currency:'NGN',amountMinor:12345};
 const input={...expected,email:'test@example.com',redirectUrl:'https://example.com/return',notificationUrl:'https://example.com/hooks/kora',methods:['card']};
 function fixture(data={reference:expected.reference,status:'success',currency:'NGN',amount:'123.45',amount_paid:'123.45'}){
  const calls=[],states=[];
  const store={begin:async()=>true,finish:async(...args)=>states.push(args)};
  const request=async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({status:true,data}),{status:200});};
  return {calls,states,store,client:new KoraSandbox(key,expected.merchantAccountRef,store,request)};
 }
 await test('live and public keys rejected',()=>{for(const bad of ['sk_live_test','pk_test_test','','sk_test_'])assert.throws(()=>new KoraSandbox(bad,'merchant',{}));});
 await test('verified payment returns no raw card data',async()=>{const f=fixture();assert.deepEqual(await f.client.verify(expected),{provider:'kora',...expected,state:'captured'});assert.equal(f.calls.length,1);});
 for(const patch of [{reference:'other'},{currency:'GBP'},{status:'pending'},{status:'failed'},{amount:'124.45'},{amount_paid:'120.45'},{amount_paid:null},{amount:null},{amount:'1e3'},{amount:'123.451'}])
  await test('verification rejects '+JSON.stringify(patch),async()=>{await assert.rejects(fixture({reference:expected.reference,status:'success',currency:'NGN',amount:'123.45',amount_paid:'123.45',...patch}).client.verify(expected));});
 await test('wrong merchant rejected before network',async()=>{const f=fixture();await assert.rejects(f.client.verify({...expected,merchantAccountRef:'other'}));assert.equal(f.calls.length,0);});
 await test('non-NGN sandbox currency rejected',async()=>{const f=fixture();await assert.rejects(f.client.verify({...expected,currency:'GHS'}));assert.equal(f.calls.length,0);});
 await test('checkout reserves and returns processing, never authorised',async()=>{const f=fixture({reference:expected.reference,checkout_url:'https://checkout.korapay.com/reference/pay'});let reserved=false;f.store.begin=async(ref,payload)=>{assert.equal(ref,expected.reference);assert.equal(payload.provider,'kora');reserved=true;return true;};const result=await f.client.createCheckout(input);assert.equal(reserved,true);assert.equal(result.state,'processing');const payload=JSON.parse(f.calls[0].options.body);assert.equal(payload.amount,123.45);assert.equal(payload.merchant_bears_cost,true);assert.deepEqual(payload.channels,['card']);assert.equal(f.calls[0].options.redirect,'error');assert.equal(f.states[0][1],'submitted');});
 await test('observed Kora sandbox hostname accepted',async()=>{const f=fixture({reference:expected.reference,checkout_url:'https://test-checkout.korapay.com/reference/pay'});assert.equal((await f.client.createCheckout(input)).state,'processing');});
 await test('lookalike sandbox hostname rejected',async()=>{const f=fixture({reference:expected.reference,checkout_url:'https://test-checkout.korapay.com.evil.example/reference/pay'});await assert.rejects(f.client.createCheckout(input));assert.equal(f.states.at(-1)[1],'unknown');});
 await test('duplicate reservation prevents POST',async()=>{const f=fixture();f.store.begin=async()=>false;await assert.rejects(f.client.createCheckout(input));assert.equal(f.calls.length,0);});
 for(const badUrl of ['http://checkout.korapay.com/pay','https://checkout.korapay.com.evil.example/pay','https://user@checkout.korapay.com/pay','https://checkout.korapay.com:444/pay'])
  await test('untrusted checkout URL rejected '+badUrl,async()=>{const f=fixture({reference:expected.reference,checkout_url:badUrl});await assert.rejects(f.client.createCheckout(input));assert.equal(f.states.at(-1)[1],'unknown');});
 await test('wrong initialization reference becomes unknown',async()=>{const f=fixture({reference:'other',checkout_url:'https://checkout.korapay.com/pay'});await assert.rejects(f.client.createCheckout(input));assert.equal(f.states.at(-1)[1],'unknown');});
 await test('timeout has no retry or provider fallback',async()=>{const states=[];let count=0;const c=new KoraSandbox(key,'kora-sandbox-eds',{begin:async()=>true,finish:async(...s)=>states.push(s)},async()=>{count++;throw Error('timeout');});await assert.rejects(c.createCheckout(input));assert.equal(count,1);assert.equal(states[0][1],'unknown');});
 await test('saved-card request refused before POST',async()=>{const f=fixture();await assert.rejects(f.client.createCheckout({...input,saveForFuture:true}));assert.equal(f.calls.length,0);});
 for(const invalid of [0,-1,1.1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])
  await test('invalid minor amount '+invalid,async()=>{const f=fixture();await assert.rejects(f.client.createCheckout({...input,amountMinor:invalid}));assert.equal(f.calls.length,0);});
 await test('webhook signature uses data only and timing-safe comparison',()=>{const f=fixture(),data={reference:expected.reference,status:'success'};const sig=createHmac('sha256',key).update(JSON.stringify(data)).digest('hex');assert.equal(f.client.authenticWebhook(data,sig),true);assert.equal(f.client.authenticWebhook({...data,status:'failed'},sig),false);for(const bad of [null,'','f'.repeat(63),'x'.repeat(64)])assert.equal(f.client.authenticWebhook(data,bad),false);});
 await test('strict NGN decimal parser',()=>{assert.equal(koraNgnMinor('0.01'),1);assert.equal(koraNgnMinor('123.4'),12340);for(const bad of [null,true,'','-1','1.001','1e2',' 1','900719925474099.99'])assert.throws(()=>koraNgnMinor(bad));});
 await test('database duplicate reservation returns false',async()=>{const store=new KoraDbAttempts({from:()=>({insert:async()=>({error:{code:'23505'}})})});assert.equal(await store.begin('ref',{}),false);});
 await test('database failure cannot reserve a payment',async()=>{const store=new KoraDbAttempts({from:()=>({insert:async()=>({error:{code:'other'}})})});await assert.rejects(store.begin('ref',{}));});
 await test('Fincra is disabled without a network client',()=>{assert.equal(FINCRA_STATUS.enabled,false);assert.equal(FINCRA_STATUS.adapterReady,false);assert.throws(requireFincraReady);});
 const base={country:'NG',currency:'NGN',merchantAccountRef:'test',enabled:false,merchantApproved:false,adapterReady:false,payoutApproved:false,methods:['card'],capabilities:[]};
 for(const provider of ['kora','fincra']){
  await test(provider+' disabled policy accepted',()=>assert.equal(paymentPolicies(JSON.stringify([{...base,provider}]))[0].enabled,false));
  for(const flag of ['enabled','adapterReady','payoutApproved'])await test(provider+' cannot claim '+flag,()=>assert.throws(()=>paymentPolicies(JSON.stringify([{...base,provider,[flag]:true}]))));
  await test(provider+' cannot claim hold/capture',()=>assert.throws(()=>paymentPolicies(JSON.stringify([{...base,provider,capabilities:['authorise','capture']}]))));
 }
 await test('Flutterwave retired from new route configuration',()=>assert.throws(()=>paymentPolicies(JSON.stringify([{...base,provider:'flutterwave'}]))));
 await test('Flutterwave cannot register a new gateway adapter',()=>assert.throws(()=>new PaymentGateway([{provider:'flutterwave',merchantAccountRef:'old',capabilities:[],execute:async()=>{}}])));
 await test('no candidate market activated',()=>assert.equal(AFRICAN_PAYMENT_CANDIDATES.some(x=>x.enabled),false));

 const {KoraSandboxSession,sandboxConfig}=(await load(path.join(root,'server/services/payments/kora-sandbox-session.ts'))).namespace;
 const config={enabled:true,production:false,key,account:'kora-test',userIds:['owner'],returnUrl:'https://example.com/return',notificationUrl:'https://example.com/webhook'};
 const requestId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 function sessionFixture(overrides={}){
  const rows=new Map();let posts=0,queries=0,failPost=false,failVerify=false;
  const store={reserve:async row=>{if(rows.has(row.reference))return false;rows.set(row.reference,{...row});return true;},find:async ref=>rows.get(ref)||null,
   update:async(ref,patch)=>{const row=rows.get(ref);if(row.state!=='verified')Object.assign(row,patch);}};
  const client={createCheckout:async input=>{posts++;if(failPost)throw Error('timeout');return{checkoutUrl:'https://test-checkout.korapay.com/session/pay'};},
   verify:async input=>{queries++;assert.equal(input.amountMinor,10000);assert.equal(input.currency,'NGN');assert.equal(input.merchantAccountRef,'kora-test');if(failVerify)throw Error('pending');return{};},authenticWebhook:(_data,sig)=>sig==='valid'};
  return{rows,store,client,service:new KoraSandboxSession({...config,...overrides},store,client),posts:()=>posts,queries:()=>queries,failPost:()=>failPost=true,failVerify:()=>failVerify=true};
 }
 await test('sandbox session creates fixed server NGN100 terms',async()=>{const f=sessionFixture();const result=await f.service.create('owner','owner@example.com',requestId);assert.equal(result.amountMinor,10000);assert.equal(f.posts(),1);assert.equal(f.rows.get(result.reference).user_id,'owner');});
 await test('reference uses proven 43-character checkout format',async()=>{const f=sessionFixture();const result=await f.service.create('owner','owner@example.com',requestId);assert.match(result.reference,/^vaydu-test-[a-f0-9]{32}$/);assert.equal(result.reference.length,43);});
 await test('different owners receive different checkout references',async()=>{const f=sessionFixture({userIds:['owner','other']});const a=await f.service.create('owner','owner@example.com',requestId),b=await f.service.create('other','other@example.com',requestId);assert.notEqual(a.reference,b.reference);});
 await test('repeated request resumes without another charge POST',async()=>{const f=sessionFixture();const a=await f.service.create('owner','owner@example.com',requestId),b=await f.service.create('owner','owner@example.com',requestId);assert.equal(a.reference,b.reference);assert.equal(a.checkoutUrl,b.checkoutUrl);assert.equal(f.posts(),1);});
 await test('concurrent requests make at most one charge POST',async()=>{const f=sessionFixture();const results=await Promise.allSettled([f.service.create('owner','owner@example.com',requestId),f.service.create('owner','owner@example.com',requestId)]);assert.equal(f.posts(),1);assert.ok(results.some(r=>r.status==='fulfilled'));});
 for(const override of [{enabled:false},{production:true},{key:'sk_live_test'},{account:''}])await test('sandbox configuration blocks '+JSON.stringify(override),async()=>{const f=sessionFixture(override);await assert.rejects(f.service.create('owner','owner@example.com',requestId));assert.equal(f.posts(),0);});
 await test('non-allowlisted user cannot create a session',async()=>{const f=sessionFixture();await assert.rejects(f.service.create('intruder','owner@example.com',requestId));assert.equal(f.posts(),0);});
 await test('invalid idempotency identifier rejected',async()=>{const f=sessionFixture();await assert.rejects(f.service.create('owner','owner@example.com','random'));assert.equal(f.posts(),0);});
 await test('uncertain submission is never resubmitted',async()=>{const f=sessionFixture();f.failPost();await assert.rejects(f.service.create('owner','owner@example.com',requestId));await assert.rejects(f.service.create('owner','owner@example.com',requestId));assert.equal(f.posts(),1);assert.equal([...f.rows.values()][0].state,'unknown');});
 await test('verification uses stored amount and records diagnostic success only',async()=>{const f=sessionFixture();const a=await f.service.create('owner','owner@example.com',requestId);const verified=await f.service.verify('owner',a.reference);assert.equal(verified.bookingUpdated,false);assert.equal(f.rows.get(a.reference).state,'verified');assert.equal(f.queries(),1);});
 await test('another allowed user cannot verify owner payment',async()=>{const f=sessionFixture({userIds:['owner','other']});const a=await f.service.create('owner','owner@example.com',requestId);await assert.rejects(f.service.verify('other',a.reference));assert.equal(f.queries(),0);});
 await test('account rotation cannot rebind an existing payment',async()=>{const f=sessionFixture();const a=await f.service.create('owner','owner@example.com',requestId);f.rows.get(a.reference).merchant_account_ref='another';await assert.rejects(f.service.verify('owner',a.reference));assert.equal(f.queries(),0);});
 await test('failed provider verification never records verified',async()=>{const f=sessionFixture();const a=await f.service.create('owner','owner@example.com',requestId);f.failVerify();await assert.rejects(f.service.verify('owner',a.reference));assert.equal(f.rows.get(a.reference).state,'submitted');});
 await test('unsigned webhook cannot query or update payment',async()=>{const f=sessionFixture();await assert.rejects(f.service.webhook({reference:'unknown'},'invalid'));assert.equal(f.queries(),0);});
 await test('valid webhook re-queries persisted terms, ignoring supplied amount',async()=>{const f=sessionFixture();const a=await f.service.create('owner','owner@example.com',requestId);await f.service.webhook({reference:a.reference,amount:999999,currency:'GBP'},'valid');assert.equal(f.queries(),1);assert.equal(f.rows.get(a.reference).state,'verified');});
 await test('replayed webhook cannot create a new payment',async()=>{const f=sessionFixture();const a=await f.service.create('owner','owner@example.com',requestId);await f.service.webhook({reference:a.reference},'valid');await f.service.webhook({reference:a.reference},'valid');assert.equal(f.posts(),1);assert.equal(f.rows.size,1);});
 await test('environment defaults leave sandbox API off',()=>{const c=sandboxConfig({});assert.equal(c.enabled,false);assert.deepEqual(c.userIds,[]);});
 // Execute real route handlers with fake transport and auth, without starting Express or making network calls.
 let routeStack=[];
 const fakeRouter={use:()=>{},post:(url,handler)=>routeStack.push({url,handler})};
 const expressModule=new vm.SyntheticModule(['Router'],function(){this.setExport('Router',()=>fakeRouter);});
 await expressModule.link(()=>{});await expressModule.evaluate();
 modules.set(path.join(root,'server/routes/express.ts'),expressModule);
 let authUser={id:'owner',email:'owner@example.com'};
 const db={auth:{getUser:async()=>({data:{user:authUser},error:null})}};
 const dbPath=path.join(root,'server/services/supabase.service.ts');
 const dbModule=new vm.SyntheticModule(['supabaseAdmin'],function(){this.setExport('supabaseAdmin',db);});
 await dbModule.link(()=>{});await dbModule.evaluate();modules.set(dbPath,dbModule);
 await load(path.join(root,'server/routes/kora-sandbox.routes.ts'));
 async function invoke(url,body,authorization){const req={body,headers:{authorization}},res={statusCode:200,status(n){this.statusCode=n;return this;},json(value){this.body=value;return this;}};await routeStack.find(r=>r.url===url).handler(req,res);return res;}
 const envKeys=['VAYDU_KORA_SANDBOX_API','NODE_ENV','KORA_TEST_SECRET_KEY','KORA_SANDBOX_MERCHANT_ACCOUNT_REF','KORA_SANDBOX_ALLOWED_USER_IDS','VAYDU_KORA_BOOKING_PILOT'];
 const oldEnv=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));
 try{
  process.env.VAYDU_KORA_SANDBOX_API='false';
  await test('checkout route unavailable with feature disabled',async()=>assert.equal((await invoke('/checkout',{requestId},'Bearer token')).statusCode,404));
  process.env.VAYDU_KORA_SANDBOX_API='true';process.env.NODE_ENV='development';process.env.KORA_TEST_SECRET_KEY=key;process.env.KORA_SANDBOX_MERCHANT_ACCOUNT_REF='kora-test';process.env.KORA_SANDBOX_ALLOWED_USER_IDS='owner';
  await test('checkout requires bearer authentication',async()=>assert.equal((await invoke('/checkout',{requestId},'')).statusCode,401));
  await test('verify requires bearer authentication',async()=>assert.equal((await invoke('/verify',{reference:'vaydu-kora-test-'+'a'.repeat(64)},'')).statusCode,401));
  await test('forged amount rejected by checkout handler',async()=>assert.equal((await invoke('/checkout',{requestId,amount:1},'Bearer token')).statusCode,400));
  await test('forged customer identity rejected by checkout handler',async()=>assert.equal((await invoke('/checkout',{requestId,userId:'other'},'Bearer token')).statusCode,400));
  process.env.VAYDU_KORA_BOOKING_PILOT='true';
  await test('booking pilot checkout requires bearer session',async()=>assert.equal((await invoke('/booking/checkout',{jobId:requestId},'')).statusCode,401));
  await test('booking pilot rejects browser-supplied fare',async()=>assert.equal((await invoke('/booking/checkout',{jobId:requestId,amount:100},'Bearer token')).statusCode,400));
  await test('booking pilot rejects browser-supplied provider',async()=>assert.equal((await invoke('/booking/checkout',{jobId:requestId,provider:'stripe'},'Bearer token')).statusCode,400));
  await test('booking pilot rejects browser-supplied callback',async()=>assert.equal((await invoke('/booking/checkout',{jobId:requestId,redirectUrl:'https://evil.example'},'Bearer token')).statusCode,400));
  await test('booking refund requires explicit sandbox outcome',async()=>assert.equal((await invoke('/booking/refund',{jobId:requestId},'Bearer token')).statusCode,400));
  authUser=null;
  await test('invalid Supabase session rejected',async()=>assert.equal((await invoke('/checkout',{requestId},'Bearer invalid')).statusCode,401));
  authUser={id:'intruder',email:'intruder@example.com'};
  await test('real route rejects authenticated non-allowlisted user',async()=>assert.equal((await invoke('/checkout',{requestId},'Bearer token')).statusCode,403));
  process.env.NODE_ENV='production';
  await test('real route unavailable in production',async()=>assert.equal((await invoke('/checkout',{requestId},'Bearer token')).statusCode,404));
 }finally{for(const k of envKeys){if(oldEnv[k]===undefined)delete process.env[k];else process.env[k]=oldEnv[k];}}

 await test('sandbox collection omits unconfigured notification URL',async()=>{const f=fixture({reference:expected.reference,checkout_url:'https://test-checkout.korapay.com/pay'});await f.client.createCheckout({...input,notificationUrl:undefined});assert.equal(Object.hasOwn(JSON.parse(f.calls[0].options.body),'notification_url'),false);});
 const refundRef='vaydu-refund-'+'a'.repeat(32);
 const refundExpected={...expected,refundReference:refundRef,completionStatus:'success'};
 function refundFixture(data){const calls=[];const request=async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({status:true,data}),{status:200});};return{calls,client:new KoraSandbox(key,expected.merchantAccountRef,{},request)};}
 await test('refund initiation submits frozen full amount and deterministic reference',async()=>{const f=refundFixture({refund_reference:refundRef,payment_reference:expected.reference,currency:'NGN',amount_returned:'123.45',status:'success'});assert.equal((await f.client.initiateRefund(refundExpected)).state,'processing');const body=JSON.parse(f.calls[0].options.body);assert.equal(body.amount,123.45);assert.equal(body.reference,refundRef);assert.equal(body.payment_reference,expected.reference);assert.equal(body.completion_status,'success');});
 await test('refund below NGN100 rejected before network',async()=>{const f=refundFixture({});await assert.rejects(f.client.initiateRefund({...refundExpected,amountMinor:9999}));assert.equal(f.calls.length,0);});
 await test('refund rejects another account before network',async()=>{const f=refundFixture({});await assert.rejects(f.client.initiateRefund({...refundExpected,merchantAccountRef:'other'}));assert.equal(f.calls.length,0);});
 const refundData={reference:refundRef,payment_reference:expected.reference,currency:'NGN',amount:'123.45',status:'success'};
 await test('refund query confirms successful exact full refund',async()=>assert.equal((await refundFixture(refundData).client.verifyRefund(refundExpected)).state,'success'));
 for(const patch of [{reference:'other'},{payment_reference:'other'},{currency:'GBP'},{amount:'100.00'},{amount:null},{status:'unrecognised'}])
  await test('refund query rejects mismatch '+JSON.stringify(patch),async()=>assert.rejects(refundFixture({...refundData,...patch}).client.verifyRefund(refundExpected)));
 for(const state of ['processing','failed'])await test('refund query preserves '+state,async()=>assert.equal((await refundFixture({...refundData,status:state}).client.verifyRefund(refundExpected)).state,state));
 const {KoraBookingPilot,pilotBookingSnapshot}=(await load(path.join(root,'server/services/payments/kora-booking-pilot.ts'))).namespace;
 const jobId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 function bookingFixture(overrides={}){
  const job={id:jobId,customer_id:'owner',status:'completed',country_code:'NG',currency_code:'NGN',payment_status:'pending',
   payment_method:'card',payment_intent_id:null,service_type_id:'ride-id',service_type:{slug:'ride'},total_price:250,
   fare_breakdown:{policyVersion:'fare-split-v1',currency:'NGN',customerCharge:250},...overrides};
  let row=null,enrolled=true,changed=false,posts=0,queries=0,refundPosts=0,refundQueries=0,postFail=false,verifyFail=false,refundFail=false,refundResult='processing';
  const store={job:async()=>structuredClone(job),find:async()=>row?structuredClone(row):null,findReference:async(ref,refund)=>row&&(refund?row.refund_reference:row.reference)===ref?structuredClone(row):null,
   reserve:async input=>{if(!enrolled)throw Error('not enrolled');if(row)return{created:false,payment:structuredClone(row)};row=structuredClone(input);return{created:true,payment:structuredClone(row)};},
   submitted:async(_id,_user,_account,state,url)=>{if(['started','submitted','unknown'].includes(row.state)){row.state=state;row.checkout_url=url||null;}},
   confirm:async()=>{row.state=changed?'requires_refund':'verified';return structuredClone(row);},
   claimRefund:async(_id,_user,_account,reference)=>{if(row.refund_reference)return{claimed:false,payment:structuredClone(row)};row.refund_reference=reference;row.refund_state='started';row.state='requires_refund';return{claimed:true,payment:structuredClone(row)};},
   refundState:async(_id,_user,_account,state)=>{if(!['success','failed'].includes(row.refund_state)){row.refund_state=state;row.state=state==='success'?'refunded':'requires_refund';}return structuredClone(row);}};
  const client={createCheckout:async input=>{posts++;assert.equal(input.amountMinor,25000);assert.equal(input.currency,'NGN');assert.match(input.reference,/^vaydu-book-[a-f0-9]{32}$/);if(postFail)throw Error('timeout');return{checkoutUrl:'https://test-checkout.korapay.com/booking/pay'};},
   verify:async input=>{queries++;assert.equal(input.amountMinor,25000);assert.equal(input.merchantAccountRef,'kora-test');if(verifyFail)throw Error('pending');},
   initiateRefund:async input=>{refundPosts++;assert.equal(input.amountMinor,25000);assert.match(input.refundReference,/^vaydu-refund-[a-f0-9]{32}$/);if(refundFail)throw Error('timeout');},
   verifyRefund:async input=>{refundQueries++;assert.equal(input.amountMinor,25000);return{state:refundResult};},authenticWebhook:(_data,sig)=>sig==='valid'};
  const cfg={...config,bookingEnabled:true};
  const service=new KoraBookingPilot(cfg,store,client,async j=>({totalAuthorisationMajor:j.fare_breakdown.customerCharge,itemBudgetMajor:0,currency:'ngn'}));
  return{job,store,client,cfg,service,row:()=>row,posts:()=>posts,queries:()=>queries,refundPosts:()=>refundPosts,refundQueries:()=>refundQueries,
   unenrol:()=>enrolled=false,change:()=>changed=true,failPost:()=>postFail=true,failVerify:()=>verifyFail=true,failRefund:()=>refundFail=true,refundResult:s=>refundResult=s};
 }
 await test('booking checkout uses completed booking fare instead of fixed diagnostic amount',async()=>{const f=bookingFixture();const r=await f.service.create('owner','owner@example.com',jobId);assert.equal(r.amountMinor,25000);assert.equal(r.operationalBookingUpdated,false);assert.equal(r.driverPayoutEnabled,false);assert.equal(f.posts(),1);assert.deepEqual(f.row().booking_snapshot,pilotBookingSnapshot(f.job));});
 for(const state of ['requested','searching','assigned','in_progress','cancelled','settled'])await test('no Kora charge for '+state+' booking',async()=>{const f=bookingFixture({status:state});await assert.rejects(f.service.create('owner','owner@example.com',jobId));assert.equal(f.posts(),0);});
 for(const patch of [{customer_id:'other'},{currency_code:'GBP'},{country_code:'GH'},{payment_method:'wallet'},{payment_status:'paid'},{payment_intent_id:'pi_original'},{service_type:{slug:'errand'}},{fare_breakdown:{customerCharge:250}}])
  await test('booking checkout rejects incompatible terms '+JSON.stringify(patch),async()=>{const f=bookingFixture(patch);await assert.rejects(f.service.create('owner','owner@example.com',jobId));assert.equal(f.posts(),0);});
 await test('booking pilot disabled by default',async()=>{const f=bookingFixture();f.cfg.bookingEnabled=false;await assert.rejects(f.service.create('owner','owner@example.com',jobId));assert.equal(f.posts(),0);});
 await test('booking pilot rejects production runtime',async()=>{const f=bookingFixture();f.cfg.production=true;await assert.rejects(f.service.create('owner','owner@example.com',jobId));assert.equal(f.posts(),0);});
 await test('unenrolled booking cannot create provider checkout',async()=>{const f=bookingFixture();f.unenrol();await assert.rejects(f.service.create('owner','owner@example.com',jobId));assert.equal(f.posts(),0);});
 await test('booking repeat resumes original provider reference without POST',async()=>{const f=bookingFixture();const a=await f.service.create('owner','owner@example.com',jobId),b=await f.service.create('owner','owner@example.com',jobId);assert.equal(a.reference,b.reference);assert.equal(f.posts(),1);});
 await test('concurrent booking calls issue one initialization',async()=>{const f=bookingFixture();await Promise.allSettled([f.service.create('owner','owner@example.com',jobId),f.service.create('owner','owner@example.com',jobId)]);assert.equal(f.posts(),1);});
 await test('unknown booking submission is not retried',async()=>{const f=bookingFixture();f.failPost();await assert.rejects(f.service.create('owner','owner@example.com',jobId));await assert.rejects(f.service.create('owner','owner@example.com',jobId));assert.equal(f.posts(),1);assert.equal(f.row().state,'unknown');});
 await test('another allowlisted user cannot verify payer booking',async()=>{const f=bookingFixture();f.cfg.userIds=['owner','other'];await f.service.create('owner','owner@example.com',jobId);await assert.rejects(f.service.verify('other',jobId));assert.equal(f.queries(),0);});
 await test('provider account cannot be switched after checkout',async()=>{const f=bookingFixture();await f.service.create('owner','owner@example.com',jobId);f.cfg.account='different';await assert.rejects(f.service.verify('owner',jobId));assert.equal(f.queries(),0);});
 await test('pending payment cannot mark booking ledger verified',async()=>{const f=bookingFixture();await f.service.create('owner','owner@example.com',jobId);f.failVerify();await assert.rejects(f.service.verify('owner',jobId));assert.equal(f.row().state,'submitted');});
 await test('verification records sandbox ledger only',async()=>{const f=bookingFixture();await f.service.create('owner','owner@example.com',jobId);const r=await f.service.verify('owner',jobId);assert.equal(r.paymentState,'verified');assert.equal(f.job.payment_status,'pending');assert.equal(r.operationalBookingUpdated,false);});
 await test('changed booking after capture enters refund recovery',async()=>{const f=bookingFixture();await f.service.create('owner','owner@example.com',jobId);f.change();const r=await f.service.verify('owner',jobId);assert.equal(r.paymentState,'requires_refund');assert.equal(r.refundState,'processing');assert.equal(f.refundPosts(),1);});
 await test('unverified payment cannot be refunded',async()=>{const f=bookingFixture();await f.service.create('owner','owner@example.com',jobId);await assert.rejects(f.service.refund('owner',jobId,'success'));assert.equal(f.refundPosts(),0);});
 await test('duplicate full refund request does not POST twice',async()=>{const f=bookingFixture();await f.service.create('owner','owner@example.com',jobId);await f.service.verify('owner',jobId);await f.service.refund('owner',jobId,'success');await f.service.refund('owner',jobId,'success');assert.equal(f.refundPosts(),1);});
 await test('refund uncertainty reconciles same reference without retry',async()=>{const f=bookingFixture();await f.service.create('owner','owner@example.com',jobId);await f.service.verify('owner',jobId);f.failRefund();await assert.rejects(f.service.refund('owner',jobId,'success'));assert.equal(f.row().refund_state,'unknown');await f.service.refund('owner',jobId,'success');assert.equal(f.refundPosts(),1);f.refundResult('success');assert.equal((await f.service.verifyRefund('owner',jobId)).paymentState,'refunded');});
 await test('processing refund is not reported as refunded',async()=>{const f=bookingFixture();await f.service.create('owner','owner@example.com',jobId);await f.service.verify('owner',jobId);await f.service.refund('owner',jobId,'success');const r=await f.service.verifyRefund('owner',jobId);assert.equal(r.paymentState,'requires_refund');assert.equal(r.refundState,'processing');});
 await test('failed refund remains visible and does not restart automatically',async()=>{const f=bookingFixture();await f.service.create('owner','owner@example.com',jobId);await f.service.verify('owner',jobId);await f.service.refund('owner',jobId,'failed');f.refundResult('failed');const r=await f.service.verifyRefund('owner',jobId);assert.equal(r.refundState,'failed');assert.equal(r.paymentState,'requires_refund');await f.service.refund('owner',jobId,'success');assert.equal(f.refundPosts(),1);});
 await test('confirmed refund cannot be downgraded by late processing response',async()=>{const f=bookingFixture();await f.service.create('owner','owner@example.com',jobId);await f.service.verify('owner',jobId);await f.service.refund('owner',jobId,'success');f.refundResult('success');await f.service.verifyRefund('owner',jobId);f.refundResult('processing');assert.equal((await f.service.verifyRefund('owner',jobId)).paymentState,'refunded');});
 await test('refund verification replay never starts a collection',async()=>{const f=bookingFixture();await f.service.create('owner','owner@example.com',jobId);await f.service.verify('owner',jobId);await f.service.refund('owner',jobId,'success');f.refundResult('success');await f.service.verifyRefund('owner',jobId);await f.service.verify('owner',jobId);assert.equal(f.posts(),1);assert.equal(f.refundPosts(),1);});

 await test('unsigned booking webhook cannot query provider',async()=>{const f=bookingFixture();await assert.rejects(f.service.webhook({reference:'vaydu-book-'+'a'.repeat(32)},'invalid'));assert.equal(f.queries(),0);});
 await test('unknown signed booking reference cannot update any payment',async()=>{const f=bookingFixture();await assert.rejects(f.service.webhook({reference:'vaydu-book-'+'a'.repeat(32)},'valid'));assert.equal(f.queries(),0);});
 await test('signed booking webhook ignores supplied amount and queries stored terms',async()=>{const f=bookingFixture();const a=await f.service.create('owner','owner@example.com',jobId);await f.service.webhook({reference:a.reference,amount:1,currency:'GBP'},'valid');assert.equal(f.queries(),1);assert.equal(f.row().state,'verified');});
 await test('signed refund webhook queries original refund before recording success',async()=>{const f=bookingFixture();await f.service.create('owner','owner@example.com',jobId);await f.service.verify('owner',jobId);await f.service.refund('owner',jobId,'success');f.refundResult('success');await f.service.webhook({reference:f.row().refund_reference,amount:1,status:'failed'},'valid');assert.equal(f.row().state,'refunded');assert.equal(f.refundQueries(),1);});

 const {PaymentAuthorityService}=(await load(path.join(root,'server/services/payment-authority.service.ts'))).namespace;
 const frozenFare={policyVersion:'fare-split-v1',currency:'NGN',customerCharge:250,driverEntitlement:200,platformFeeAmount:30,driverCommissionAmount:20};
 await test('booking pilot integrates actual frozen fare authority',async()=>{const f=bookingFixture({fare_breakdown:frozenFare});const service=new KoraBookingPilot(f.cfg,f.store,f.client,j=>PaymentAuthorityService.resolve(j));const result=await service.create('owner','owner@example.com',jobId);assert.equal(result.amountMinor,25000);});
 await test('actual fare authority rejects unbalanced split before checkout',async()=>{const f=bookingFixture({fare_breakdown:{...frozenFare,driverEntitlement:201}});const service=new KoraBookingPilot(f.cfg,f.store,f.client,j=>PaymentAuthorityService.resolve(j));await assert.rejects(service.create('owner','owner@example.com',jobId));assert.equal(f.posts(),0);});
 await test('actual fare authority rejects quote versus snapshot amount mismatch',async()=>{const f=bookingFixture({total_price:251,fare_breakdown:frozenFare});const service=new KoraBookingPilot(f.cfg,f.store,f.client,j=>PaymentAuthorityService.resolve(j));await assert.rejects(service.create('owner','owner@example.com',jobId));assert.equal(f.posts(),0);});
 console.log('OFFLINE_PROVIDER_CHECKS_PASSED='+passed);
})().catch(error=>{console.error(error);process.exitCode=1;});
