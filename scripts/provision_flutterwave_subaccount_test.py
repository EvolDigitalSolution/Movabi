"""Run manually in the authenticated SSH terminal. No DB credential access or network requests."""
import getpass
import json
import os
from pathlib import Path
import re
import secrets
import warnings

def provision(root=None):
    warnings.simplefilter('error',getpass.GetPassWarning)
    with open('/dev/tty','r') as reader,open('/dev/tty','w') as writer:
        if not os.isatty(reader.fileno()) or not os.isatty(writer.fileno()):raise RuntimeError('Private interactive terminal required')
        directory=Path(root) if root else Path.home()/'.config'/'vaydu-collection-subaccount-sandbox'
        resolved=directory.resolve()
        if directory.is_symlink() or any((p/'.git').exists() for p in [resolved,*resolved.parents]):raise RuntimeError('Use a private location outside every repository')
        directory.mkdir(parents=True,mode=0o700,exist_ok=True)
        if directory.stat().st_uid!=os.getuid():raise RuntimeError('Private directory ownership mismatch')
        os.chmod(directory,0o700)
        target=directory/'flutterwave-test.env'
        if target.exists() or target.is_symlink():raise RuntimeError('Existing configuration retained; review its supported injection mechanism instead of overwriting it')
        key=getpass.getpass('Flutterwave v3 TEST secret key (hidden): ',stream=writer)
        if not re.fullmatch(r'FLWSECK_TEST-[A-Za-z0-9_-]+',key):raise RuntimeError('Test-key format required; no provider request made')
        merchant=getpass.getpass('Approved test merchant reference (hidden): ',stream=writer)
        if not re.fullmatch(r'[A-Za-z0-9_.:-]{1,120}',merchant):raise RuntimeError('Merchant reference format invalid')
        values={'FLUTTERWAVE_TEST_SECRET_KEY':key,'FLUTTERWAVE_LIVE_SECRET_KEY':'','FLUTTERWAVE_COLLECTION_MERCHANT_REF':merchant,
                'DRIVER_SUBACCOUNT_FINGERPRINT_KEY':secrets.token_urlsafe(48),'VAYDU_DRIVER_SUBACCOUNT_SANDBOX':'false',
                'VAYDU_FLUTTERWAVE_BOOKING_SPLIT_SANDBOX':'false','VAYDU_BOOKING_SPLIT_TIMING_APPROVED':'false'}
        fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0),0o600)
        with os.fdopen(fd,'w') as output:
            for name,value in values.items():output.write(name+'='+value+'\n')
            output.flush();os.fsync(output.fileno())
        # This confirms format/storage only; do not claim actual merchant identity or API entitlement.
        print(json.dumps({'testKeyFormatConfirmed':True,'providerRequestsMade':False,'liveKeyConfigured':False,
                          'sandboxEnabled':False,'databaseConnectionConfigured':False,'privateFile':str(target),'permissions':'0600'}))

if __name__=='__main__':
    try:provision()
    except (RuntimeError,getpass.GetPassWarning) as error:
        print('PROVISIONING_BLOCKED: '+str(error))
        raise SystemExit(1)
    except Exception:
        print('PROVISIONING_BLOCKED: private test-key configuration was not completed; no secret values printed')
        raise SystemExit(1)
