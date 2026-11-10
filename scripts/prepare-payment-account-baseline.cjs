'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),release=path.join(root,'deploy/vaydu-payment-account-setup');
const source=path.join(root,'.temp/payment-account-baseline/validated-8879bdb792f3');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const manifest=JSON.parse(fs.readFileSync(path.join(source,'source-manifest.json'),'utf8'));
const reviewed={'server/index.ts':'329e1047e0602a0f837c220ebb67b3a024167176100128c9ab4509e576bbd302','server/routes/driver-onboarding.routes.ts':'3b2daa18d92b0f20f6062b253a89b2a4611c7a21850066b3422cd31870d0cbf1','server/services/driver-requirement.service.ts':'5abd560a67e36d4ce9a6ab57d259f3ae7abbb2b4765d3d3cb24782622fed3f47'};
if(JSON.stringify(manifest.files)!==JSON.stringify(reviewed)||manifest.baselineImage!=='sha256:1ef978c931bf390273f4648f6c8bdce04231338d64ae7c6ead7e4e10d723c6aa')throw Error('reviewed_baseline_manifest_mismatch');
const driver='318e6be9-9164-41fa-bb0c-c5ccd3526585';
const helper=`async function vayduSetupForOnboarding(driverId: string, app: any): Promise<any> {
  if (driverId !== '${driver}') return undefined;
  try {
    const setup=app.locals.vayduPaymentAccountSetup;
    if(!setup)throw new Error('setup_unavailable');
    return await setup.status(driverId);
  } catch {
    return {provider:'flutterwave',state:'unavailable',available:false};
  }
}

`;
const block=`    // Selected develop TEST driver only. Other drivers retain deployed rules.
    if(input.paymentAccountRequired===true){
      const payment=input.paymentAccount;
      const ready=payment?.provider==='flutterwave'&&payment.available===true&&payment.state==='completed';
      const reason=ready?'Payment account destination verified.':payment?.state==='reconciliation_required'
        ?'Payment account setup needs reconciliation before continuing.'
        :'Set up and verify your payment account before submitting onboarding.';
      requirements.push({code:'payout.payment_account',label:'Payment account',category:'documents',status:ready?'completed':'missing',required:true,completed:ready,blockingForSubmission:!ready,blockingForOnline:!ready,needsAdminReview:payment?.state==='reconciliation_required',reason,services:selectedServices});
    }
`;
const files=[];
for(const name of Object.keys(manifest.files)){
 const bytes=fs.readFileSync(path.join(source,name));if(sha(bytes)!==manifest.files[name])throw Error('verified_baseline_changed');
 const text=bytes.toString('utf8'),nl=text.includes('\r\n')?'\r\n':'\n';const ops=[];
 const add=(before,after)=>ops.push({before:before.replace(/\n/g,nl),after:after.replace(/\n/g,nl)});
 if(name==='server/index.ts'){
  add("app.use('/api/payment', paymentRoutes);","require('/app/server/payment-account-closure/mount.cjs')(app, {db: require('/app/server/services/supabase.service').supabaseAdmin});\napp.use('/api/payment', paymentRoutes);");
 }else if(name==='server/routes/driver-onboarding.routes.ts'){
  for(const line of text.split(/\r?\n/).filter(l=>l.includes('const resolution=DriverRequirementService.resolve('))){
   if(!line.endsWith('});'))throw Error('unexpected_requirement_call');
   add(line,line.slice(0,-3)+`,paymentAccountRequired:driverId==='${driver}',paymentAccount:await vayduSetupForOnboarding(driverId,req.app)});`);
  }
  if(ops.length!==2)throw Error('two_reviewed_requirement_calls_required');
  add('export default router;',helper+'export default router;');
 }else if(name==='server/services/driver-requirement.service.ts'){
  add('now?: Date }): DriverRequirementResolution {',"now?: Date; paymentAccountRequired?: boolean; paymentAccount?: {provider:string|null;state:string;available:boolean} }): DriverRequirementResolution {");
  add('    const automaticCodes=new Set(requirements.map(r=>r.code));',block+'    const automaticCodes=new Set(requirements.map(r=>r.code));');
  add("if(profile.stripe_connect_status!=='connected')warnings.push", "if(input.paymentAccountRequired!==true&&profile.stripe_connect_status!=='connected')warnings.push");
 }else throw Error('unexpected_baseline_member');
 let patched=text;for(const op of ops){if(patched.split(op.before).length!==2)throw Error('non_unique_patch_anchor:'+name);patched=patched.replace(op.before,op.after);}
 const dest=path.join(release,'baseline',name);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,bytes);
 files.push({path:name,beforeSha256:sha(bytes),afterSha256:sha(Buffer.from(patched)),operations:ops});
}
const plan={purpose:'selected-ng-driver-onboarding-integration-v1',archiveSha256:'342c495d392092637376d48da9e3d4376de4b34609deb3588d17bd97872b6c23',baselineApiImage:manifest.baselineImage,files};
fs.writeFileSync(path.join(release,'integration-plan.json'),JSON.stringify(plan,null,2)+'\n');
console.log(JSON.stringify({baselineValidated:true,patchedFiles:files.length,gbRulesUnchanged:true,localEntryNotCopied:true,cashFilesChanged:false}));
