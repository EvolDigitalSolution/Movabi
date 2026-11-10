'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),release=path.join(root,'deploy/vaydu-payment-account-setup');
cp.execFileSync(process.execPath,[path.join(root,'node_modules/typescript/bin/tsc'),'-p',path.join(release,'closure/tsconfig.json')],{stdio:'inherit'});
const files={
 'payment-account-closure/router.js':'onboarding/router.js',
 'payment-account-closure/service.js':'onboarding/service.js',
 'services/payments/flutterwave-driver-payout.js':'services/payments/flutterwave-driver-payout.js',
 'services/payments/flutterwave-wallet-collection.js':'services/payments/flutterwave-wallet-collection.js',
 'services/payments/payment-contracts.js':'services/payments/payment-contracts.js',
};
for(const [source,target] of Object.entries(files)){
 const dest=path.join(release,'api',target);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(release,'closure/build',source),dest);
}
// Remove obsolete, superseded closure files, never repository/server sources.
for(const name of ['router.js','services/driver-payment-account.service.js','services/supabase.service.js','services/payout-eligibility.service.js','services/stripe.service.js','services/payments/stripe-payment-bridge.js']){
 const dest=path.join(release,'api',name);if(fs.existsSync(dest))fs.unlinkSync(dest);
}
console.log('Setup-only closure compiled; manifest is generated only after release tests.');
