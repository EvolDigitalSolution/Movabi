const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {stripTypeScriptTypes}=require('node:module');
(async()=>{
 let router;let countryRows=[{country_code:'NG'}];
 const tests=[];const normalize=x=>JSON.parse(JSON.stringify(x));
 function expect(value){const obj={toBe:x=>assert.equal(value,x),toEqual:x=>assert.deepEqual(normalize(value),normalize(x)),toHaveLength:n=>assert.equal(value.length,n),toContain:x=>assert(value.includes(x)),toThrow:x=>assert.throws(value,e=>String(e.message).includes(x))};obj.not={toContain:x=>assert(!value.includes(x))};obj.rejects={toThrow:async x=>{let error;try{await value;}catch(e){error=e;}assert(error&&String(error.message).includes(x),'Expected rejection '+x);}};return obj;}
 const context=vm.createContext({process,URL,AbortSignal,fetch,console,setTimeout,clearTimeout});const cache=new Map();
 async function load(file){if(cache.has(file))return cache.get(file);const module=new vm.SourceTextModule(stripTypeScriptTypes(fs.readFileSync(file,'utf8'),{mode:'transform'}),{context,identifier:file});cache.set(file,module);await module.link(async(spec,from)=>{
  if(spec==='express')return new vm.SyntheticModule(['Router'],function(){this.setExport('Router',()=>{router={middleware:[],use(fn){this.middleware.push(fn);},get(p,h){this.config=h;},post(p,h){this.operation=h;}};return router;});},{context});
  if(spec==='express-rate-limit')return new vm.SyntheticModule(['rateLimit'],function(){this.setExport('rateLimit',()=>()=>{});},{context});
  if(spec.endsWith('/supabase.service'))return new vm.SyntheticModule(['supabaseAdmin'],function(){this.setExport('supabaseAdmin',{auth:{getUser:async token=>({data:token==='valid'?{user:{id:'owner'}}:{},error:null})},rpc:async()=>({data:countryRows,error:null})});},{context});
  if(spec==='vitest')return new vm.SyntheticModule(['describe','it','expect'],function(){this.setExport('describe',(_name,fn)=>fn());this.setExport('it',(name,fn)=>tests.push({name,fn}));this.setExport('expect',expect);},{context});
  return load(path.resolve(path.dirname(from.identifier),spec+'.ts'));
 });return module;}
 const root=path.resolve(__dirname,'..');const module=await load(path.join(root,'src/testing/maps-provider-v23.spec.ts'));await module.evaluate();
 const addressModule=await load(path.join(root,'src/testing/address-country-v23.spec.ts'));await addressModule.evaluate();
 for(const test of tests){await test.fn();console.log('PASS '+test.name);}
 const routeModule=await load(path.join(root,'server/routes/maps-v23.routes.ts'));await routeModule.evaluate();
 const service=cache.get(path.join(root,'server/services/maps-v23.ts')).namespace.mapsV23;
 let requests=0;service.search=async()=>{requests++;return {results:[],attribution:'Mapbox'};};
 const response=()=>({code:200,setHeader(){},status(n){this.code=n;return this;},json(body){this.body=body;return this;}});
 let req={headers:{}};let res=response();let next=false;await router.middleware[0](req,res,()=>next=true);assert.equal(res.code,401);assert.equal(next,false);
 req={headers:{authorization:'Bearer invalid'}};res=response();await router.middleware[0](req,res,()=>next=true);assert.equal(res.code,401);
 req={headers:{authorization:'Bearer valid'}};res=response();await router.middleware[0](req,res,()=>next=true);assert.equal(next,true);assert.equal(req.mapsUserId,'owner');
 res=response();await router.operation({params:{operation:'search'},body:{country:'GB',query:'London'}},res);assert.equal(res.code,400);assert.equal(requests,0);
 res=response();await router.operation({params:{operation:'search'},body:{country:'NG',query:'Lekki'}},res);assert.equal(res.code,200);assert.equal(requests,1);
 countryRows=[{country_code:'NG'},{country_code:'GB'}];res=response();await router.operation({params:{operation:'search'},body:{global:true,query:'Orita obele'}},res);assert.equal(res.code,200);assert.equal(requests,2);
 countryRows=null;res=response();await router.operation({params:{operation:'search'},body:{country:'NG',query:'Lekki'}},res);assert.equal(res.code,503);assert.equal(requests,2);
 res=response();await router.operation({params:{operation:'route'},body:{start:{lat:null,lng:3},end:{lat:6,lng:3}}},res);assert.equal(res.code,400);
 console.log('MAP_HTTP_GUARDS=PASS_AUTHENTICATION_COUNTRY_CONFIGURATION_AND_INPUT');
 console.log('MAP_ADAPTER_CHECKS_PASSED='+tests.length);
})().catch(e=>{console.error(e);process.exitCode=1;});
