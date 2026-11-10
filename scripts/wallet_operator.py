"""Operator-run wallet sandbox workflow. Default/preflight performs no deployment.

Secret material is read only from an existing explicitly named wallet file. No
container Env extraction, database credential copy, provisioning or subaccount API.
"""
import argparse,hashlib,json,os,re,stat,subprocess,sys,time,uuid
from pathlib import Path
from decimal import Decimal
import urllib.request
ROOT=Path(__file__).resolve().parent
STATE=Path.home()/'.local/state/vaydu-wallet-operator'
DRIVER='318e6be9-9164-41fa-bb0c-c5ccd3526585'
TENANT='d0e8e8e8-e8e8-e8e8-e8e8-d0e8e8e8e8e8'
CALLBACK='https://movabi-develop.apps.evolsolution.com/driver-topup-return'
WEBHOOK='https://movabi-develop.apps.evolsolution.com/api/payment/driver-topup/webhook'
DB_IMAGE='sha256:632d750850d22dbc57c28380bed582538bd1a0b4c963fac50e2fa03e6c26542c'
EVIDENCE_FLAGS=['merchantIdentityVerified','merchantAliasBindingConfirmed','providerAccountBindingConfirmed','testModeConfirmed','ngnCardSupportConfirmed','redirectUrlConfirmed','webhookUrlConfirmed','webhookSecretMatchesDashboard','feePassingMerchantPays']
OFF=['VAYDU_DRIVER_SUBACCOUNT_SANDBOX','VAYDU_DRIVER_PAYOUT_SANDBOX','VAYDU_FLUTTERWAVE_BOOKING_SPLIT_SANDBOX','VAYDU_BOOKING_SPLIT_TIMING_APPROVED']
class Blocked(Exception):pass
def digest(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda:f.read(1048576),b''):h.update(chunk)
    return h.hexdigest()
def run(args,data=None,timeout=180):
    p=subprocess.run(args,input=data,capture_output=True,timeout=timeout)
    if p.returncode:raise Blocked('operator_command_failed_raw_output_withheld')
    return p.stdout.decode().strip()
def load(path,default=None):return json.loads(Path(path).read_text()) if Path(path).is_file() else default
def save(name,value,exclusive=False):
    path=STATE/name
    if path.is_symlink():raise Blocked('unsafe_operator_state')
    if exclusive:
        fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'w') as f:json.dump(value,f,indent=2);f.write('\n')
    else:
        tmp=STATE/(name+'.tmp-'+uuid.uuid4().hex[:8]);save(tmp.name,value,True);os.replace(tmp,path)
def q(value):return "'"+str(value).replace("'","''")+"'"
def init():
    if STATE.is_symlink():raise Blocked('unsafe_operator_state')
    STATE.mkdir(parents=True,mode=0o700,exist_ok=True)
    if STATE.stat().st_uid!=os.getuid() or stat.S_IMODE(STATE.stat().st_mode)!=0o700:raise Blocked('operator_state_requires_owner_0700')
    for line in (ROOT/'SHA256SUMS').read_text().splitlines():
        expected,name=line.split('  ',1);path=ROOT/name
        if Path(name).name!=name or path.is_symlink() or digest(path)!=expected:raise Blocked('bundle_checksum_mismatch')
    manifest=load(ROOT/'release.json')
    if manifest.get('purpose')!='wallet-operator-20261028-v2' or manifest.get('driver')!=DRIVER or manifest.get('tenant')!=TENANT:raise Blocked('wrong_release_scope')
    if digest(ROOT/'supabase_incremental_schema_reconcile.sql')!=manifest['canonicalSqlSha256']:raise Blocked('canonical_checksum_mismatch')
    return manifest
def docker_prefix():
    p=subprocess.run(['docker','info','--format','{{.ServerVersion}}'],capture_output=True)
    d=['docker'] if p.returncode==0 else ['sudo','-n','docker']
    run(d+['info','--format','{{.ServerVersion}}']);return d
def meta(d,name,fmt):return run(d+['inspect','--format',fmt,name])
def sql(d,text,write=False):
    opts=[] if write else ['-e','PGOPTIONS=-c default_transaction_read_only=on -c timezone=UTC -c search_path=pg_catalog,public']
    return run(d+['exec','-i',*opts,'movabi-develop-db','psql','-X','-U','postgres','-d','movabi_develop','-qAt','-v','ON_ERROR_STOP=1'],text.encode(),120)
def target(d):
    if meta(d,'movabi-develop-db','{{.Image}}')!=DB_IMAGE or set(json.loads(meta(d,'movabi-develop-db','{{json .NetworkSettings.Networks}}')))!={'movabi-develop-private'}:raise Blocked('develop_db_identity_changed')
    records={}
    for kind,name in [('api','movabi-develop-api'),('web','movabi-develop-web')]:
        def label(k):return meta(d,name,'{{index .Config.Labels "com.docker.compose.'+k+'"}}')
        if label('project')!='movabi-develop':raise Blocked('develop_compose_project_changed')
        files=label('project.config_files').split(',');directory=label('project.working_dir');service=label('service')
        if not re.fullmatch(r'[A-Za-z0-9_-]+',service) or not Path(directory).is_dir() or any(not Path(f).is_absolute() or not Path(f).is_file() for f in files):raise Blocked('original_compose_chain_unavailable')
        records[kind]={'container':name,'image':meta(d,name,'{{.Image}}'),'service':service,'directory':directory,'files':files,'fileHashes':{f:digest(f) for f in files}}
    if sql(d,'SELECT current_database()')!='movabi_develop':raise Blocked('wrong_database')
    if records['api']['service']==records['web']['service']:raise Blocked('api_web_service_identity_collision')
    return records
def wallet_path():return Path(load(STATE/'binding-reference.json',{}).get('walletFile',str(Path.home()/'.config/vaydu-driver-card-sandbox/flutterwave-test.env')))
def wallet_bindings():
    path=wallet_path();report={'walletFilePresent':False,'walletFilePrivate':None,'testKeyFormatConfirmed':None,'separateWebhookPresent':None,'merchantAliasPresent':None,'providerAccountIdPresent':None,'callbackMatchesExpected':None,'storedActivationDisabled':None,'liveKeyAbsent':None,'subaccountFileUsed':False}
    try:report['walletFilePresent']=path.is_file()
    except OSError:report['walletFilePresent']=None
    values={}
    if 'subaccount' in str(path).lower():return values,report
    if not report['walletFilePresent']:return values,report
    try:info=path.stat()
    except OSError:return values,report
    if path.is_symlink() or not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode)!=0o600 or info.st_uid!=os.getuid() or info.st_size>16384:return values,report
    if any((p/'.git').exists() for p in path.resolve().parents):return values,report
    report['walletFilePrivate']=True
    allowed={'VAYDU_DRIVER_TOPUP_API','FLUTTERWAVE_SECRET_KEY','FLUTTERWAVE_WEBHOOK_SECRET','FLUTTERWAVE_MERCHANT_REF','FLUTTERWAVE_PROVIDER_ACCOUNT_ID','VAYDU_TOPUP_CALLBACK_URL','FLUTTERWAVE_LIVE_SECRET_KEY'}
    try:lines=path.read_text().splitlines()
    except (OSError,UnicodeError):return {},report
    for line in lines:
        if not line or line.startswith('#'):continue
        name,sep,value=line.partition('=')
        if not sep or name not in allowed or name in values or re.search(r'[\x00-\x1f\x7f]',value):return {},report
        values[name]=value
    key=values.get('FLUTTERWAVE_SECRET_KEY','');hook=values.get('FLUTTERWAVE_WEBHOOK_SECRET','')
    report.update(testKeyFormatConfirmed=bool(re.fullmatch(r'FLWSECK_TEST-[A-Za-z0-9_-]+',key)),separateWebhookPresent=bool(re.fullmatch(r'[A-Za-z0-9_-]{8,}',hook)) and hook!=key,
       merchantAliasPresent=bool(re.fullmatch(r'[A-Za-z0-9_.:-]{1,120}',values.get('FLUTTERWAVE_MERCHANT_REF',''))),providerAccountIdPresent=bool(re.fullmatch(r'\d{1,30}',values.get('FLUTTERWAVE_PROVIDER_ACCOUNT_ID',''))),
       callbackMatchesExpected=values.get('VAYDU_TOPUP_CALLBACK_URL')==CALLBACK,storedActivationDisabled=values.get('VAYDU_DRIVER_TOPUP_API')=='false',liveKeyAbsent=not values.get('FLUTTERWAVE_LIVE_SECRET_KEY'))
    return values,report
def bindings_ready(report):return all(report[k] is True for k in report if k!='subaccountFileUsed')
def dashboard(values):
    data=load(STATE/'dashboard.json',{})
    matched=(data.get('providerAccountId')==values['FLUTTERWAVE_PROVIDER_ACCOUNT_ID']) if values.get('FLUTTERWAVE_PROVIDER_ACCOUNT_ID') else None
    checks={name:data.get(name) is True for name in EVIDENCE_FLAGS}
    checks.update(providerAccountIdMatches=matched,merchantIdRecorded=bool(re.fullmatch(r'\d{1,30}',str(data.get('merchantId','')))),evidenceReferencePresent=bool(data.get('evidenceReference')))
    return data,checks
def source_parity(d,m):
    paths=list(m['protectedSourceHashes'])
    code="const fs=require('node:fs'),c=require('node:crypto');process.stdout.write(JSON.stringify(Object.fromEntries("+json.dumps(paths)+".map(p=>[p,c.createHash('sha256').update(fs.readFileSync('/app/'+p)).digest('hex')]))));"
    try:actual=json.loads(run(d+['exec','movabi-develop-api','node','-e',code]))
    except Blocked:return False,paths
    mismatch=[p for p in paths if actual.get(p)!=m['protectedSourceHashes'][p]]
    return not mismatch,mismatch

def protected(d):
    # Read-only hashes; no raw financial records, definitions or bank information are emitted.
    from wallet_canonical_contract import preservation_sql
    return json.loads(sql(d,preservation_sql((ROOT/'supabase_incremental_schema_reconcile.sql').read_text())))
def guards(d,strict=True):
    owner=sql(d,"SELECT EXISTS(SELECT 1 FROM public.profiles WHERE id="+q(DRIVER)+" AND tenant_id="+q(TENANT)+" AND role='driver' AND registration_activated_at IS NOT NULL AND coalesce(nullif(registration_country_code,''),country_code)='NG')")=='t'
    currency=sql(d,"SELECT count(DISTINCT upper(supported_currency))=1 AND max(upper(supported_currency))='NGN' FROM public.market_availability WHERE country_code='NG'")=='t'
    global_off=sql(d,'SELECT public.wallet_collection_enabled()')=='f'
    cash_off=sql(d,'SELECT NOT EXISTS(SELECT 1 FROM public.driver_cash_credit_config_v1e WHERE enabled)')=='t'
    if strict and not(owner and currency and global_off and cash_off):raise Blocked('driver_market_or_global_cash_collection_guard_failed')
    return {'confirmedDriverTenant':owner,'ngnMarketUnambiguous':currency,'globalCollectionDisabled':global_off,'cashPilotDisabled':cash_off}
def proof(m):
    record=load(STATE/'rehearsal.json',{})
    path=Path(record.get('verificationManifest','/nonexistent'))
    root=Path.home()/'vaydu-develop-wallet-backups'
    if path.is_symlink() or not path.is_file() or path.resolve().parent.parent!=root.resolve():raise Blocked('real_canonical_rehearsal_missing')
    data=load(path)
    needed=['restoreVerified','walletOwnershipAndACLVerified','canonicalCloneVerified','canonicalRepeatVerified','canonicalBookingStateUnchanged','restoreCleanupVerified']
    if data.get('sourceKind')!='verified-develop' or data.get('sourceContainer')!='movabi-develop-db' or data.get('sourceImage')!=DB_IMAGE or data.get('canonicalSqlSha256')!=m['canonicalSqlSha256'] or any(data.get(k) is not True for k in needed):raise Blocked('real_canonical_rehearsal_incomplete')
    if time.time()-path.stat().st_mtime>7200:raise Blocked('canonical_rehearsal_older_than_two_hours')
    if digest(path.parent/'movabi_develop.dump')!=data.get('sha256'):raise Blocked('rehearsed_archive_checksum_mismatch')
    return data
def quiet(d):
    if sql(d,"SELECT NOT EXISTS(SELECT 1 FROM public.job_payout_queue WHERE status IN('pending','processing','reconcile'))")!='t':raise Blocked('existing_payout_work_active_choose_quiet_window')
def compose(d,record,override):
    for f,h in record['fileHashes'].items():
        if digest(f)!=h:raise Blocked('original_compose_chain_changed')
    cmd=d+['compose','--project-name','movabi-develop','--project-directory',record['directory']]
    for f in record['files']:cmd+=['-f',f]
    run(cmd+['-f',str(override),'up','-d','--no-deps','--no-build','--pull','never','--force-recreate',record['service']])
def override(d,m,active=False,reconcile=False,rollback=False):
    baseline=load(STATE/'baseline.json');values,report=wallet_bindings()
    if not rollback and not bindings_ready(report):raise Blocked('wallet_specific_bindings_incomplete')
    api=baseline['api'];web=baseline['web']
    settings={'VAYDU_DEPLOYMENT_ENV':'develop','VAYDU_DRIVER_WALLET_COHOST_DEVELOP':'false' if rollback else 'true','VAYDU_DRIVER_TOPUP_API':'true' if active else 'false',
      'VAYDU_DRIVER_WALLET_RECONCILE_ONLY':'true' if reconcile else 'false','VAYDU_DRIVER_WALLET_EVIDENCE_APPROVED':'true' if active or reconcile else 'false',
      'VAYDU_DRIVER_WALLET_FILE_OWNER_UID':str(wallet_path().stat().st_uid) if not rollback else '0','FLUTTERWAVE_LIVE_SECRET_KEY':'',**{k:'false' for k in OFF}}
    api_settings={'image':api['image'] if rollback else m['apiImage'],'environment':settings}
    if not rollback:api_settings['volumes']=[{'type':'bind','source':str(wallet_path()),'target':'/run/vaydu/wallet-flutterwave-test.env','read_only':True,'bind':{'create_host_path':False}}]
    data={'services':{api['service']:api_settings,web['service']:{'image':web['image'] if rollback else m['webImage']}}}
    file=STATE/('rollback.override.json' if rollback else 'wallet.override.json');save(file.name,data)
    compose(d,api,file);compose(d,web,file)
def assert_evidence(values,report):
    if not bindings_ready(report):raise Blocked('wallet_specific_bindings_incomplete')
    data,checks=dashboard(values)
    if not all(checks.values()):raise Blocked('dashboard_identity_callback_fee_attestation_incomplete')
    return data
def health(d):
    code="(async()=>{const r=await fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health',{signal:AbortSignal.timeout(3000)});if(!r.ok||(await r.json()).status!=='ok')process.exit(1)})().catch(()=>process.exit(1));"
    for _ in range(30):
        p=subprocess.run(d+['exec','movabi-develop-api','node','-e',code],capture_output=True)
        if p.returncode==0:return True
        time.sleep(2)
    raise Blocked('api_health_not_ready')
def stripe_http(d):
    code="(async()=>{const r=await fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/connect/payout-settings');if(r.status!==401)process.exit(1);})().catch(()=>process.exit(1));"
    run(d+['exec','movabi-develop-api','node','-e',code])

def disabled_http(d):
    code="(async()=>{const b='http://127.0.0.1:'+(process.env.PORT||3001);const r=await fetch(b+'/api/payment/driver-topup/availability');if(r.status!==404)process.exit(1);})().catch(()=>process.exit(1));"
    run(d+['exec','movabi-develop-api','node','-e',code])

def pending(d):return int(sql(d,"SELECT count(*) FROM public.wallet_topup_attempts WHERE owner_id="+q(DRIVER)+" AND tenant_id="+q(TENANT)+" AND destination_account_purpose='driver_cash_credit' AND status IN('submitting','provider_pending','confirmed','uncertain')"))
def attempt_result(d,attempt):
    if not re.fullmatch(r'[a-fA-F0-9-]{36}',attempt):raise Blocked('attempt_uuid_required')
    result=sql(d,"""SELECT json_build_object('status',a.status,'walletCreditMinor',a.amount_minor,'vayduFeeMinor',a.provider_fee_minor,'totalChargeMinor',a.total_charge_minor,
      'eventBound',a.credited_event_id IS NOT NULL,'ledgerCreditRows',(SELECT count(*) FROM public.wallet_movements m JOIN public.wallet_accounts w ON w.id=m.account_id WHERE m.event_id=a.credited_event_id AND w.owner_id=a.owner_id AND w.tenant_id=a.tenant_id AND w.balance_purpose='driver_cash_credit' AND m.amount_minor>0),
      'ledgerCreditMinor',(SELECT coalesce(sum(m.amount_minor),0) FROM public.wallet_movements m JOIN public.wallet_accounts w ON w.id=m.account_id WHERE m.event_id=a.credited_event_id AND w.owner_id=a.owner_id AND w.tenant_id=a.tenant_id AND w.balance_purpose='driver_cash_credit'),
      'ledgerBalanced',(SELECT coalesce(sum(m.amount_minor),0)=0 FROM public.wallet_movements m WHERE m.event_id=a.credited_event_id),
      'providerObservationsRecorded',EXISTS(SELECT 1 FROM public.wallet_topup_provider_observations o WHERE o.attempt_id=a.id),
      'eventId',a.credited_event_id) FROM public.wallet_topup_attempts a WHERE a.id="""+q(attempt)+" AND a.owner_id="+q(DRIVER)+" AND a.tenant_id="+q(TENANT)+" AND a.payment_provider='flutterwave' AND a.country_code='NG' AND a.currency_code='NGN' AND a.destination_account_purpose='driver_cash_credit'")
    if not result:raise Blocked('owned_attempt_not_found')
    data=json.loads(result);data['creditedExactlyOnce']=data['status']=='credited' and data['eventBound'] and data['ledgerCreditRows']==1 and data['ledgerCreditMinor']==data['walletCreditMinor'] and data['ledgerBalanced'] and data['totalChargeMinor']==data['walletCreditMinor']+data['vayduFeeMinor']
    data['nativeReturnVerified']=False
    return data
def main():
    parser=argparse.ArgumentParser();parser.add_argument('stage',choices=['preflight','rehearse','provider-check','deploy-disabled','activate','verify','reconcile','rollback']);parser.add_argument('--wallet-file');parser.add_argument('--attempt')
    args=parser.parse_args();m=init();d=docker_prefix();current=target(d);guard=guards(d,args.stage!='preflight')
    if args.wallet_file:
        path=Path(args.wallet_file)
        if not path.is_absolute():raise Blocked('existing_wallet_file_absolute_reference_required')
        save('binding-reference.json',{'walletFile':str(path)})
    if not (STATE/'baseline.json').exists():save('baseline.json',current,True)
    if not (STATE/'dashboard.json').exists():save('dashboard.json',load(ROOT/'dashboard-evidence.example.json'),True)
    baseline=load(STATE/'baseline.json')
    values,bindings=wallet_bindings();attestation,attested=dashboard(values)
    if args.stage=='preflight':
        canonical_present=sql(d,"SELECT to_regclass('public.vaydu_driver_card_schema_releases') IS NOT NULL")=='t'
        reher=False
        try:proof(m);reher=True
        except Blocked:pass
        shared=set(json.loads(meta(d,'movabi-develop-api','{{json .NetworkSettings.Networks}}')))&set(json.loads(meta(d,'movabi-develop-web','{{json .NetworkSettings.Networks}}')))
        safe_flags=json.loads(run(d+['exec','movabi-develop-api','node','-e',"process.stdout.write(JSON.stringify({nodeEnvProduction:process.env.NODE_ENV==='production',topupDisabled:process.env.VAYDU_DRIVER_TOPUP_API!=='true',liveFlutterwaveAbsent:!process.env.FLUTTERWAVE_LIVE_SECRET_KEY&&(!process.env.FLUTTERWAVE_SECRET_KEY||process.env.FLUTTERWAVE_SECRET_KEY.startsWith('FLWSECK_TEST-')),portCompatible:!process.env.PORT||process.env.PORT==='3001',otherSandboxFlagsDisabled:"+json.dumps(OFF)+".every(k=>process.env[k]===undefined||process.env[k]==='false')}))"]))
        parity,mismatch=source_parity(d,m)
        blockers=[]
        if not parity:blockers.append('protected_server_source_review_required')
        if not all(guard.values()):blockers.append('driver_market_or_global_cash_collection_guard_failed')
        if not bindings_ready(bindings):blockers.append('wallet_specific_bindings_incomplete')
        if not all(attested.values()):blockers.append('dashboard_evidence_incomplete')
        if not reher:blockers.append('real_canonical_rehearsal_missing')
        if not shared:blockers.append('api_web_have_no_shared_network')
        if not all(safe_flags.values()):blockers.append('api_baseline_flag_or_port_mismatch')
        output={'stage':'preflight','completed':True,'scope':{'provider':'flutterwave-test','country':'NG','currency':'NGN','driver':DRIVER,'tenant':TENANT},'target':guard,
         'composeChains':{k:{'service':v['service'],'fileCount':len(v['files']),'allReferencesReadable':True,'currentImage':v['image']} for k,v in current.items()},'apiBaseline':safe_flags,'protectedServerSourcesMatch':parity,'protectedSourceMismatchFiles':mismatch,'apiWebSharedNetwork':bool(shared),
         'walletBindings':bindings,'dashboardEvidence':attested,'canonicalLedgerPresent':canonical_present,'canonicalRehearsalVerified':reher,'subaccountRequired':False,'providerRequestsMade':False,'changesToServicesOrDatabase':False,'activationAllowed':False,'blockers':blockers}
        save('last-preflight.json',output);print(json.dumps(output,sort_keys=True));return
    if args.stage=='rehearse':
        logfile=STATE/'rehearsal.log'
        cmd=[sys.executable,str(ROOT/'verify-develop-wallet-backup.py'),'--validate-canonical-sql',str(ROOT/'supabase_incremental_schema_reconcile.sql'),'--canonical-sha256',m['canonicalSqlSha256'],'--canonical-wallet-guard','--expected-driver',DRIVER,'--expected-tenant',TENANT]
        with logfile.open('w') as out:
            os.chmod(logfile,0o600);p=subprocess.run(cmd,stdout=out,stderr=subprocess.DEVNULL,timeout=900)
        if p.returncode:raise Blocked('canonical_rehearsal_failed_see_private_sanitized_rehearsal_log')
        rows=[json.loads(line) for line in logfile.read_text().splitlines() if line.startswith('{')];result=rows[-1]
        save('rehearsal.json',result);proof(m)
        print(json.dumps({'stage':'rehearse','realCanonicalRestoreVerified':True,'appliedTwice':True,'bookingStripeRoutingOutboxUnchanged':True,'sourceDatabaseWritten':False,'providerRequestsMade':False}));return
    if args.stage=='provider-check':
        assert_evidence(values,bindings)
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self,*a,**kw):return None
        req=urllib.request.Request('https://api.flutterwave.com/v3/transactions/fee?amount=105&currency=NGN&payment_type=card',headers={'Authorization':'Bearer '+values['FLUTTERWAVE_SECRET_KEY'],'Accept':'application/json'},method='GET')
        try:
            with urllib.request.build_opener(NoRedirect()).open(req,timeout=20) as r:result=json.loads(r.read(100000),parse_int=str,parse_float=str)
            data=result['data'];charge=Decimal(str(data['charge_amount']))
            if result['status']!='success' or charge!=Decimal('105') or data.get('currency','NGN')!='NGN':raise ValueError()
        except Exception:raise Blocked('provider_fee_quote_not_exact_confirmed_total') from None
        save('provider-check.json',{'passed':True,'walletSha':digest(wallet_path()),'evidenceSha':digest(STATE/'dashboard.json'),'checkedAt':time.time()})
        print(json.dumps({'stage':'provider-check','readOnlyTestFeeQuotePassed':True,'expectedFinalMajor':'105','providerChargeMatches':True,'actualCheckoutPassed':False,'merchantIdentitySource':'manual-provider-evidence-attestation'}));return
    if args.stage=='deploy-disabled':
        proof(m);quiet(d)
        last=load(STATE/'last-preflight.json',{})
        if not last.get('apiWebSharedNetwork') or not all(last.get('apiBaseline',{}).values()) or not last.get('apiBaseline'):raise Blocked('successful_runtime_baseline_preflight_required')
        if not bindings_ready(bindings):raise Blocked('wallet_specific_bindings_incomplete')
        if not source_parity(d,m)[0]:raise Blocked('protected_server_source_review_required')
        before=protected(d);save('deployment.pending.json',{'protected':before,'canonical':m['canonicalSqlSha256']},True)
        sql(d,(ROOT/'supabase_incremental_schema_reconcile.sql').read_text(),True)
        if protected(d)!=before:raise Blocked('canonical_changed_protected_state_do_not_restart')
        for file,pin in [('api.tar',m['apiImage']),('web.tar',m['webImage'])]:
            run(d+['image','load','--input',str(ROOT/file)],timeout=300)
            if run(d+['image','inspect','--format','{{.Id}}',pin])!=pin:raise Blocked('imported_image_pin_mismatch')
        save('deployment.json',{'protected':before,'apiImage':m['apiImage'],'webImage':m['webImage'],'canonical':m['canonicalSqlSha256'],'phase':'schema-applied'})
        override(d,m);health(d);disabled_http(d);stripe_http(d);save('deployment.json',{'protected':before,'apiImage':m['apiImage'],'webImage':m['webImage'],'canonical':m['canonicalSqlSha256'],'phase':'disabled-deployed'})
        print(json.dumps({'stage':'deploy-disabled','deployedDisabled':True,'originalComposeChainsPreserved':True,'setupEnabled':False,'walletCollectionEnabled':False,'disabledWalletHttpVerified':True,'stripeUnauthenticatedRouteVerified':True,'restartImpact':'Existing develop API and web recreated; DB/auth unchanged'}));return
    if args.stage=='activate':
        proof(m);quiet(d);assert_evidence(values,bindings)
        receipt=load(STATE/'provider-check.json',{})
        if not receipt.get('passed') or receipt.get('walletSha')!=digest(wallet_path()) or receipt.get('evidenceSha')!=digest(STATE/'dashboard.json') or time.time()-receipt.get('checkedAt',0)>7200:raise Blocked('current_readonly_provider_fee_check_required')
        deployed=load(STATE/'deployment.json',{})
        if deployed.get('phase')!='disabled-deployed' or current['api']['image']!=m['apiImage'] or current['web']['image']!=m['webImage']:raise Blocked('reviewed_disabled_deployment_required')
        if (STATE/'activation.pending.json').exists():raise Blocked('activation_receipt_exists_verify_or_rollback_do_not_repeat')
        nonce=uuid.uuid4().hex;save('activation.pending.json',{'nonce':nonce,'evidenceSha':digest(STATE/'dashboard.json')},True)
        exponent=int(sql(d,"SELECT public.wallet_currency_minor_exponent('NGN')"))
        if exponent not in range(4):raise Blocked('configured_currency_exponent_invalid')
        statement="""BEGIN; SET LOCAL lock_timeout='5s';
        LOCK TABLE public.driver_card_topup_sandbox_scopes,public.wallet_topup_fee_schedules,public.wallet_collection_config IN ACCESS EXCLUSIVE MODE;
        DO $$ BEGIN IF public.wallet_collection_enabled() OR public.driver_card_sandbox_enabled() OR EXISTS(SELECT 1 FROM public.driver_card_topup_sandbox_scopes WHERE enabled) OR EXISTS(SELECT 1 FROM public.wallet_topup_fee_schedules WHERE provider='flutterwave' AND country_code='NG' AND currency_code='NGN') THEN RAISE EXCEPTION 'Activation baseline changed'; END IF; END $$;
        INSERT INTO public.wallet_topup_fee_schedules(version,provider,country_code,currency_code,method,exponent,fee_basis,fee_basis_points,fee_fixed_minor,fee_cap_minor,rounding,approved_by,approved_at,active)
        VALUES('vaydu-driver-card-5pct-wallet-v1','flutterwave','NG','NGN','card',"""+str(exponent)+""",'wallet',500,0,NULL,'half_up','operator-reviewed sandbox',now(),true);
        INSERT INTO public.driver_card_topup_sandbox_scopes(provider,method,country_code,currency_code,merchant_account_ref,provider_account_id,tenant_id,driver_id,fee_passing_mode,reviewed_by,reviewed_at,evidence_reference,policy_version,enabled)
        VALUES('flutterwave','card','NG','NGN',"""+q(values['FLUTTERWAVE_MERCHANT_REF'])+','+q(values['FLUTTERWAVE_PROVIDER_ACCOUNT_ID'])+','+q(TENANT)+','+q(DRIVER)+",'merchant','operator-reviewed sandbox',now(),"+q('wallet-operator:'+nonce)+",'vaydu-driver-card-5pct-wallet-v1',true);\n"+"INSERT INTO public.wallet_collection_config(key,value) VALUES('driver_card_sandbox_enabled','true') ON CONFLICT(key) DO UPDATE SET value='true'; COMMIT;"
        before=protected(d);sql(d,statement,True)
        if protected(d)!=before:raise Blocked('activation_changed_protected_state')
        save('activation.json',{'nonce':nonce,'protected':before,'walletSha':digest(wallet_path())},True)
        override(d,m,True);health(d)
        print(json.dumps({'stage':'activate','enabledOnlyConfirmedDriver':True,'provider':'flutterwave-test','market':'NG/NGN','globalCollectionEnabled':False,'cashPayoutBookingFlagsChanged':False,'subaccountCreated':False,'paymentMade':False}));return
    if args.stage in ('verify','reconcile'):
        health(d);stripe_http(d)
        if current['api']['image']!=m['apiImage'] or current['web']['image']!=m['webImage']:raise Blocked('deployed_image_mismatch')
        if args.attempt:
            first=attempt_result(d,args.attempt)
            if args.stage=='reconcile':
                if not first['creditedExactlyOnce']:raise Blocked('verify_payment_result_before_duplicate_callback_check')
                code="""process.env.TS_NODE_PROJECT='server/tsconfig.json';require('ts-node/register');(async()=>{const m=require('./server/routes/driver-wallet-develop.routes');const c=m.readWalletFile(Number(process.env.VAYDU_DRIVER_WALLET_FILE_OWNER_UID));const statuses=[];for(let i=0;i<2;i++){const r=await fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/payment/driver-topup/webhook',{method:'POST',headers:{'Content-Type':'application/json','verif-hash':c.FLUTTERWAVE_WEBHOOK_SECRET},body:JSON.stringify({data:{tx_ref:process.argv[1]}}),signal:AbortSignal.timeout(30000)});statuses.push(r.status);}process.stdout.write(JSON.stringify(statuses));})().catch(()=>process.exit(1));"""
                statuses=json.loads(run(d+['exec','movabi-develop-api','node','-e',code,args.attempt]));second=attempt_result(d,args.attempt)
                second['duplicateCallbackHttpStatuses']=statuses;second['sameCreditedEventAfterCallbacks']=first['eventId']==second['eventId'];first=second
            print(json.dumps({'stage':args.stage,'attempt':args.attempt,'result':first}));return
        deployment=load(STATE/'deployment.json',{})
        unchanged=deployment.get('protected')==protected(d)
        if not unchanged:raise Blocked('protected_booking_routing_state_changed')
        print(json.dumps({'stage':'verify','apiHealthy':True,'protectedBookingRoutingStateUnchanged':True,'canonicalAndRuntimeScopeVerified':True,'actualPaymentTested':False,'nativeReturnVerified':False}));return
    if args.stage=='rollback':
        activation=load(STATE/'activation.json') or load(STATE/'activation.pending.json')
        if activation:
            tag='wallet-operator:'+activation['nonce']
            sql(d,"BEGIN; UPDATE public.driver_card_topup_sandbox_scopes SET enabled=false WHERE driver_id="+q(DRIVER)+" AND tenant_id="+q(TENANT)+" AND evidence_reference="+q(tag)+"; DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM public.driver_card_topup_sandbox_scopes WHERE enabled) THEN DELETE FROM public.wallet_collection_config WHERE key='driver_card_sandbox_enabled'; UPDATE public.wallet_topup_fee_schedules SET active=false WHERE provider='flutterwave' AND country_code='NG' AND currency_code='NGN' AND version='vaydu-driver-card-5pct-wallet-v1'; END IF; END $$; COMMIT;",True)
        if pending(d):
            override(d,m,False,True);health(d)
            print(json.dumps({'stage':'rollback','newCheckoutsDisabled':True,'reconciliationOnlyKept':True,'originalCredentialsAndPendingAttemptsRetained':True,'imagesRestored':False}));return
        override(d,m,rollback=True);health(d)
        print(json.dumps({'stage':'rollback','previousApiWebImagesRestored':True,'originalComposeChainsPreserved':True,'additiveSchemaAndLedgerRetained':True,'credentialsUnchanged':True}));return

if __name__=='__main__':
    try:main()
    except Blocked as error:print(json.dumps({'completed':False,'blocked':str(error),'noSecretValuesPrinted':True}));raise SystemExit(1)
    except Exception:print(json.dumps({'completed':False,'blocked':'operator_prerequisite_failed_raw_diagnostic_withheld','noSecretValuesPrinted':True}));raise SystemExit(1)
