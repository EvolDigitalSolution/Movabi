import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
const context='.temp/wallet-minimal-build';
const review=JSON.parse(fs.readFileSync('.temp/vaydu-wallet-minimal-20261028/reviewed-sources.json','utf8'));
function patchIndex(index:string,changed=false){
 const files:any=Object.fromEntries(Object.keys(review.protectedSourceHashes).map(p=>['/app/'+p,fs.readFileSync('.temp/deployed-wallet-source-comparison/deployed/'+p)]));files['/app/server/index.ts']=Buffer.from(index);files['/app/server/unreviewed-dependency.ts']=Buffer.from('preserve baseline dependency');
 if(changed)files['/app/server/services/stripe.service.ts']=Buffer.from('unexpected');
 const before={...files},writes:string[]=[];
 const fake={realpathSync:(p:string)=>p,lstatSync:(p:string)=>{if(!files[p]){const e:any=new Error();e.code='ENOENT';throw e;}return{isFile:()=>true};},readFileSync:(p:string,encoding?:string)=>encoding?files[p].toString():files[p],writeFileSync:(p:string,data:string)=>{writes.push(p);files[p]=Buffer.from(data);}};
 const run=()=>vm.runInNewContext(fs.readFileSync(context+'/payload/patch-index.cjs','utf8'),{require:(p:string)=>p==='fs'?fake:p==='crypto'?crypto:null});
 return{run,files,before,writes};
}
describe('minimal overlay preserves the actual deployed architecture',()=>{
 it('changes only one index mount and leaves every baseline dependency unchanged',()=>{const t=patchIndex("app.use('/api/payment', paymentRoutes);\n");t.run();expect(t.writes).toEqual(['/app/server/index.ts']);expect(t.files['/app/server/index.ts'].toString()).toContain("driverWalletDevelopRouter(require('./services/supabase.service').supabaseAdmin)");for(const p of Object.keys(t.before).filter(p=>p!=='/app/server/index.ts'))expect(t.files[p]).toEqual(t.before[p]);});
 it('refuses changed protected content before index writes',()=>{const t=patchIndex("app.use('/api/payment', paymentRoutes);",true);expect(t.run).toThrow('protected_source_mismatch');expect(t.writes).toEqual([]);});
 it.each(["app.use('/changed', paymentRoutes);","app.use('/api/payment', paymentRoutes);app.use('/api/payment', paymentRoutes);","app.use('/api/payment/driver-topup', other);app.use('/api/payment', paymentRoutes);"])('refuses an unreviewed index layout',index=>{const t=patchIndex(index);expect(t.run).toThrow('index_mount_requires_review');expect(t.writes).toEqual([]);});
 it('adds neither absent Stripe module nor booking/payout/service replacements',()=>{expect(review.walletClosure).toHaveLength(11);for(const p of [...Object.keys(review.protectedSourceHashes),...review.protectedAbsentPaths])expect(review.walletClosure).not.toContain(p);});
 it('uses the identical existing Supabase admin object',()=>{const existing={sentinel:'existing-client'};const exports:any={};vm.runInNewContext(fs.readFileSync(context+'/payload/wallet-sandbox/services/supabase.service.js','utf8'),{exports,require:(p:string)=>{expect(p).toBe('../../services/supabase.service');return{supabaseAdmin:existing};}});expect(exports.supabaseAdmin).toBe(existing);});
});
