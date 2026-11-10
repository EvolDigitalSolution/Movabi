// Guarded mount: inject the baseline's supabaseAdmin, then expose the setup-only router.
module.exports = function mount(app, deps) {
  const db = deps && deps.db;
  if (!db || !db.auth || typeof db.auth.getUser !== 'function' || typeof db.from!=='function' || typeof db.rpc!=='function') throw new Error('supabase_admin_required');
  if(!deps.provider){
    let target;try{target=new URL(db.supabaseUrl).href;}catch{throw Error('develop_database_target_required');}
    if(!['http://movabi-develop-kong:8000/','https://movabi-supabase-develop.apps.evolsolution.com/'].includes(target))throw Error('develop_database_target_required');
  }
  const provider = deps.provider || require('./runtime.cjs')({...process.env});
  const mod = require('./onboarding/router.js');
  const factory = mod.driverPaymentAccountRouter || (mod.default && mod.default.driverPaymentAccountRouter);
  if (typeof factory !== 'function') throw new Error('payment_account_router_missing');
  const {SetupService}=require('./onboarding/service.js');
  app.locals.vayduPaymentAccountSetup=new SetupService(db,provider);
  app.use('/api/driver-payment-account', factory(db, provider, deps.requestLimit || 20));
};
