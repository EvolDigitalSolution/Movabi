'use strict';
const fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),release=path.join(root,'deploy/vaydu-payment-account-setup');
const {plan}=require(path.join(release,'patch-entry.cjs'));
function compile(text,target){const output=ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,output);}
for(const version of ['before','after']){
 for(const item of plan.files.filter(f=>f.path!=='server/index.ts')){
  let text=fs.readFileSync(path.join(release,'baseline',item.path),'utf8');
  if(version==='after')for(const edit of item.operations)text=text.replace(edit.before,edit.after);
  compile(text,path.join(release,'tests/compiled',version,item.path.replace(/^server\//,'').replace(/\.ts$/,'.js')));
 }
 for(const name of ['models/driver-profile.model','models/driver-passenger-licence.model','models/driver-vehicle.model','services/driver-identity-editability.service']){
  compile(fs.readFileSync(path.join(root,'server',name+'.ts'),'utf8'),path.join(release,'tests/compiled',version,name+'.js'));
 }
}
console.log('Compiled verified before/after onboarding fixtures; production payload unchanged.');
