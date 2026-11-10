"""Manual hidden terminal provisioning; never called with credentials as arguments."""
import getpass,json,os,pathlib,re,urllib.request,warnings
from decimal import Decimal

CALLBACK='https://movabi-develop.apps.evolsolution.com/driver-topup-return'
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None

def fee_probe(secret):
    # Test prefix is checked again at the network boundary. No charge is created.
    if not re.fullmatch(r'FLWSECK_TEST-[A-Za-z0-9_-]+',secret):raise RuntimeError('Test key required before any provider request')
    request=urllib.request.Request('https://api.flutterwave.com/v3/transactions/fee?amount=105&currency=NGN&payment_type=card',headers={'Authorization':'Bearer '+secret,'Accept':'application/json'})
    try:
        with urllib.request.build_opener(NoRedirect()).open(request,timeout=20) as response:
            result=json.loads(response.read(100000),parse_int=str,parse_float=str)
    except Exception:raise RuntimeError('Read-only test-key/NGN fee query failed; no credentials printed') from None
    if result.get('status')!='success' or not isinstance(result.get('data'),dict):raise RuntimeError('Provider fee query was not confirmed')
    return result['data']

def provision(provider='flutterwave',root=None,probe=fee_probe):
    if provider not in ('flutterwave','stripe'):raise RuntimeError('Unsupported provider')
    warnings.simplefilter('error',getpass.GetPassWarning)
    # Separate handles work on non-seekable TTYs. Never use text mode r+/w+.
    with open('/dev/tty','r') as reader,open('/dev/tty','w') as writer:
        if not os.isatty(reader.fileno()) or not os.isatty(writer.fileno()):raise RuntimeError('Interactive terminal required')
        directory=pathlib.Path(root) if root is not None else pathlib.Path.home()/'.config'/'vaydu-driver-card-sandbox'
        directory.mkdir(mode=0o700,parents=True,exist_ok=True)
        if directory.is_symlink() or directory.stat().st_uid!=os.getuid():raise RuntimeError('Unsafe private configuration directory')
        resolved=directory.resolve()
        if any((parent/'.git').exists() for parent in [resolved,*resolved.parents]):raise RuntimeError('Refusing secret storage inside any repository; use your secret manager')
        os.chmod(directory,0o700)
        target=directory/(provider+'-test.env')
        if target.exists() or target.is_symlink():raise RuntimeError('Existing secret file retained; use the existing secret manager to rotate it')
        hidden=lambda prompt:getpass.getpass(prompt,stream=writer)
        key=hidden(provider+' TEST secret key (hidden): ')
        pattern=r'FLWSECK_TEST-[A-Za-z0-9_-]+' if provider=='flutterwave' else r'sk_test_[A-Za-z0-9_]+'
        if not re.fullmatch(pattern,key):raise RuntimeError('Test-key format required; no provider request made')
        values={'VAYDU_DRIVER_TOPUP_API':'false',('FLUTTERWAVE_SECRET_KEY' if provider=='flutterwave' else 'STRIPE_SECRET_KEY'):key}
        result={'provider':provider,'testKeyFormatConfirmed':True,'paymentsEnabled':False,'servicesChanged':False}
        if provider=='flutterwave':
            webhook=hidden('Separate Flutterwave webhook secret (hidden): ')
            if webhook==key or not re.fullmatch(r'[A-Za-z0-9_-]{8,}',webhook):raise RuntimeError('A distinct webhook secret of at least 8 letters/digits/underscores/hyphens is required')
            merchant=hidden('Approved Flutterwave test merchant reference (hidden): ')
            if not re.fullmatch(r'[A-Za-z0-9_.:-]{1,120}',merchant):raise RuntimeError('Merchant reference format invalid')
            account=hidden('Flutterwave test account ID from dashboard, digits (hidden): ')
            if not re.fullmatch(r'[0-9]{1,30}',account):raise RuntimeError('Provider account ID required')
            callback=hidden('Approved callback URL (hidden; use '+CALLBACK+'): ')
            if callback!=CALLBACK:raise RuntimeError('Expected develop callback approval required; nothing stored')
            # A fee estimate is not a dashboard-setting/account-identity attestation.
            estimated=probe(key)
            charge=str(estimated.get('charge_amount',''))
            if not re.fullmatch(r'\d+(?:\.\d+)?',charge) or Decimal(charge)!=Decimal('105') or estimated.get('currency','NGN')!='NGN':raise RuntimeError('Provider estimates an unagreed final charge; review test merchant fee-passing settings')
            values.update({'FLUTTERWAVE_WEBHOOK_SECRET':webhook,'FLUTTERWAVE_MERCHANT_REF':merchant,'FLUTTERWAVE_PROVIDER_ACCOUNT_ID':account,'VAYDU_TOPUP_CALLBACK_URL':callback})
            result.update({'ngnFeeQueryPassed':True,'merchantReferenceConfigured':True,'providerAccountIdConfigured':True,'callbackConfigured':True,'merchantDashboardReviewStillRequired':True,'actualCheckoutStillUnverified':True})
        descriptor=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0),0o600)
        with os.fdopen(descriptor,'w') as output:
            output.write(''.join(name+'='+value+'\n' for name,value in values.items()));output.flush();os.fsync(output.fileno())
        result.update({'secretFile':str(target),'permissions':'0600'})
        print(json.dumps(result),flush=True)
        return result

if __name__=='__main__':
    try:provision()
    except (RuntimeError,getpass.GetPassWarning) as error:print('PROVISIONING_BLOCKED: '+str(error));raise SystemExit(1)
    except Exception:print('PROVISIONING_BLOCKED: private configuration failed; no credentials printed');raise SystemExit(1)
