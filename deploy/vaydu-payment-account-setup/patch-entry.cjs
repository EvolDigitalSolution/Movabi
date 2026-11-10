'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const plan=JSON.parse(fs.readFileSync(path.join(__dirname,'integration-plan.json'),'utf8'));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function apply(root='/app'){
 const expected=['server/index.ts','server/routes/driver-onboarding.routes.ts','server/services/driver-requirement.service.ts'].sort();
 if(JSON.stringify(plan.files.map(f=>f.path).sort())!==JSON.stringify(expected))throw Error('exact_reviewed_integration_files_required');
 const pending=plan.files.map(f=>{
  const target=path.resolve(root,f.path);
  if(!target.startsWith(path.resolve(root)+path.sep)||fs.lstatSync(target).isSymbolicLink())throw Error('unsafe_patch_target');
  const bytes=fs.readFileSync(target);return {f,target,bytes,digest:sha(bytes)};
 });
 if(pending.every(p=>p.digest===p.f.afterSha256))return {completed:true,alreadyPatched:true};
 if(pending.some(p=>p.digest!==p.f.beforeSha256))throw Error('baseline_or_partial_integration_mismatch');
 if(!['.ts','.js'].some(ext=>fs.existsSync(path.join(root,'server/services/supabase.service'+ext))))throw Error('baseline_supabase_module_missing');
 for(const p of pending){
  let text=p.bytes.toString('utf8');
  for(const edit of p.f.operations){if(text.split(edit.before).length!==2)throw Error('non_unique_patch_anchor');text=text.replace(edit.before,edit.after);}
  p.result=Buffer.from(text);if(sha(p.result)!==p.f.afterSha256)throw Error('reviewed_patch_result_mismatch');
 }
 for(const p of pending)fs.writeFileSync(p.target,p.result);
 return {completed:true,patchedFiles:pending.length};
}
module.exports={apply,plan};
if(require.main===module){try{console.log(JSON.stringify(apply(process.argv[2]||'/app')));}catch(e){console.error(/^[a-z_]+$/.test(e.message)?e.message:'integration_patch_failed');process.exitCode=1;}}
