"""Read-only v3 test-merchant probe. Never loads DB credentials or prints provider payloads."""
import argparse
from decimal import Decimal
from datetime import datetime,timezone
import json
import os
from pathlib import Path
import re
import stat
import urllib.error
import urllib.request

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None

def safe_provider_error(raw):
    """Never echo arbitrary provider prose: it can contain keys, account numbers or names."""
    result={'providerCode':None,'providerMessage':'[unrecognized provider text withheld]',
            'messageDisclosure':'canonicalized_allowlist_only'}
    if len(raw)>65536:
        result['providerMessage']='[oversized error body withheld]';return result
    try:value=json.loads(raw)
    except Exception:
        result['providerMessage']='[non-JSON error body withheld]';return result
    if not isinstance(value,dict):return result
    nested=value.get('error') if isinstance(value.get('error'),dict) else {}
    code=value.get('code',value.get('error_code',nested.get('code')))
    known_codes={'INVALID_REQUEST','VALIDATION_ERROR','INVALID_PAGE','NOT_FOUND','NO_SUBACCOUNTS',
                 'UNAUTHORIZED','FORBIDDEN','AUTHORIZATION_ERROR','INVALID_AUTHORIZATION_KEY','INVALID_SECRET_KEY'}
    if isinstance(code,(str,int)) and not isinstance(code,bool):
        text=str(code)
        if text in known_codes or re.fullmatch(r'[0-9]{3,5}',text):result['providerCode']=text
        else:result['providerCode']='[present but withheld]'
    message=value.get('message',nested.get('message'))
    if not isinstance(message,str):return result
    normal=' '.join(message.casefold().split()).rstrip('.!')
    exact={
      'no subaccounts found':('no_rows','No subaccounts found'),
      'no subaccount found':('no_rows','No subaccount found'),
      'no subaccounts available':('no_rows','No subaccounts available'),
      'subaccounts not found':('no_rows','Subaccounts not found'),
      'invalid page':('page_validation','Invalid page'),
      'invalid page number':('page_validation','Invalid page number'),
      'page must be a positive integer':('page_validation','Page must be a positive integer'),
      'invalid authorization key':('authentication','Invalid authorization key'),
      'invalid secret key':('authentication','Invalid secret key'),
      'unauthorized':('authentication','Unauthorized'),
      'access denied':('access_policy','Access denied'),
      'permission denied':('access_policy','Permission denied'),
      'forbidden':('access_policy','Forbidden'),
      'this endpoint is not available in test mode':('environment_policy','This endpoint is not available in test mode'),
    }
    if normal in exact:
        result['messageCategory'],result['providerMessage']=exact[normal]
    elif re.match(r'^no subaccounts? (?:found|available)\b',normal):
        result.update(messageCategory='no_rows',providerMessage='Provider reports no subaccounts; additional details withheld')
    elif re.match(r'^(?:invalid|missing|required) (?:page|account_bank|account_number)\b',normal):
        result.update(messageCategory='parameter_validation',providerMessage='Provider rejected a request parameter; values withheld')
    return result

def diagnose_subaccounts(key,opener=None):
    if not re.fullmatch(r'FLWSECK_TEST-[A-Za-z0-9_-]+',key):raise RuntimeError('TEST key required before any provider request')
    opener=opener or urllib.request.build_opener(NoRedirect())
    rows=[]
    # Both are documented GET variants. No account/bank filters or creation requests.
    for path,parameters in [('/subaccounts',{}),('/subaccounts?page=1',{'page':'1'})]:
        request=urllib.request.Request('https://api.flutterwave.com/v3'+path,headers={'Authorization':'Bearer '+key,'Accept':'application/json'},method='GET')
        row={'method':'GET','path':path,'parameters':parameters,'requestedAtUTC':datetime.now(timezone.utc).isoformat()}
        try:
            with opener.open(request,timeout=20) as response:
                raw=response.read(1024*1024+1)
                row['httpStatus']=response.getcode()
            if len(raw)>1024*1024:raise ValueError('oversize')
            value=json.loads(raw)
            if isinstance(value,dict) and value.get('status')=='success' and isinstance(value.get('data'),list):
                row.update(accessible=True,countOnReturnedPage=len(value['data']))
            else:row.update(accessible=False,**safe_provider_error(raw))
        except urllib.error.HTTPError as error:
            try:raw=error.read(65537)
            except Exception:raw=b''
            details=safe_provider_error(raw)
            empty=int(error.code)==400 and details.get('providerMessage') in {'Subaccounts not found','No subaccounts found','No subaccount found','No subaccounts available'}
            row.update(accessible=empty,httpStatus=int(error.code),emptyList=empty,**details)
            if empty:row.update(countOnReturnedPage=0,creationPermissionVerified=False,recreationPermitted=False)
        except Exception:row.update(accessible=False,reason='request_or_response_unconfirmed')
        rows.append(row)
    return {'diagnosticOnly':True,'requestsReadOnly':True,'merchantIdentityVerified':False,
            'creationTested':False,'capabilityApproved':False,'rawProviderPayloadPrinted':False,'checks':rows}

def load_test_key(path):
    path=Path(path)
    if path.is_symlink():raise RuntimeError('Private key file must not be a symlink')
    info=path.stat()
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode)!=0o600 or info.st_uid!=os.getuid() or info.st_size>16384:
        raise RuntimeError('Expected current-user private 0600 credential file')
    resolved=path.resolve()
    if any((p/'.git').exists() for p in [resolved.parent,*resolved.parents]):raise RuntimeError('Credential file must be outside Git')
    values={}
    for line in path.read_text(encoding='utf-8').splitlines():
        if not line or line.startswith('#'):continue
        name,separator,value=line.partition('=')
        if not separator or name in values:raise RuntimeError('Invalid private credential-file format')
        if name.startswith(('SUPABASE_','POSTGRES_','PGRST_','DATABASE_')):raise RuntimeError('This probe does not accept a database credential file')
        values[name]=value
    key=values.get('FLUTTERWAVE_TEST_SECRET_KEY','')
    if not re.fullmatch(r'FLWSECK_TEST-[A-Za-z0-9_-]+',key):raise RuntimeError('TEST key required before any provider request')
    if values.get('FLUTTERWAVE_LIVE_SECRET_KEY'):raise RuntimeError('LIVE key must remain unset')
    for name in ['VAYDU_DRIVER_SUBACCOUNT_SANDBOX','VAYDU_FLUTTERWAVE_BOOKING_SPLIT_SANDBOX','VAYDU_BOOKING_SPLIT_TIMING_APPROVED']:
        if values.get(name)!='false':raise RuntimeError('Expected all sandbox collection/timing gates to remain false during this probe')
    return key

def probe(key,opener=None):
    if not re.fullmatch(r'FLWSECK_TEST-[A-Za-z0-9_-]+',key):raise RuntimeError('TEST key required before any provider request')
    opener=opener or urllib.request.build_opener(NoRedirect())
    report={'testKeyFormatConfirmed':True,'providerRequestsMade':True,'requestsReadOnly':True,'bankDetailsPrinted':False,'subaccountCreationTested':False,
            'splitSemanticsTested':False,'settlementTested':False,'transfersTested':False,'merchantIdentityVerified':False}
    endpoints=[('ngBankCatalogue','/banks/NG'),('collectionSubaccountList','/subaccounts?page=1'),
               ('ngnCardFeeQuote','/transactions/fee?amount=105&currency=NGN&payment_type=card')]
    for stage,path in endpoints:
        request=urllib.request.Request('https://api.flutterwave.com/v3'+path,headers={'Authorization':'Bearer '+key,'Accept':'application/json'},method='GET')
        try:
            with opener.open(request,timeout=20) as response:
                raw=response.read(1024*1024+1)
                if len(raw)>1024*1024:raise ValueError('oversize')
                result=json.loads(raw,parse_int=str,parse_float=str)
            data=result.get('data')
            if result.get('status')!='success':
                report[stage]={'accessible':False,'reason':'provider_rejected_request'};continue
            if stage!='ngnCardFeeQuote':
                if not isinstance(data,list):raise ValueError('shape')
                report[stage]={'accessible':True,'countOnReturnedPage':len(data)}
            else:
                if not isinstance(data,dict):raise ValueError('shape')
                charge=str(data.get('charge_amount',''));fee=str(data.get('fee',''))
                if data.get('currency') not in (None,'NGN'):raise ValueError('currency')
                if not re.fullmatch(r'\d+(?:\.\d+)?',charge) or not re.fullmatch(r'\d+(?:\.\d+)?',fee):raise ValueError('money')
                report[stage]={'accessible':True,'currency':'NGN','requestedMajor':'105','estimatedChargeMajor':charge,'estimatedProviderFeeMajor':fee,'currencySource':'provider' if data.get('currency')=='NGN' else 'request',
                               'unexpectedAdditionalCharge':Decimal(charge)!=Decimal('105'),'dashboardFeePassingStillUnverified':True}
        except urllib.error.HTTPError as error:
            if stage=='collectionSubaccountList':
                try:raw=error.read(65537)
                except Exception:raw=b''
                details=safe_provider_error(raw)
                empty=int(error.code)==400 and details.get('providerMessage') in {'Subaccounts not found','No subaccounts found','No subaccount found','No subaccounts available'}
                report[stage]={'accessible':empty,'httpStatus':int(error.code),'emptyList':empty,**details}
                if empty:report[stage].update(countOnReturnedPage=0,creationPermissionVerified=False,recreationPermitted=False)
            else:report[stage]={'accessible':False,'httpStatus':int(error.code)}
        except Exception:report[stage]={'accessible':False,'reason':'request_or_response_unconfirmed'}
    return report

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--diagnose-subaccounts',action='store_true')
    args=parser.parse_args()
    path=Path.home()/'.config/vaydu-collection-subaccount-sandbox/flutterwave-test.env'
    try:
        key=load_test_key(path)
        report=diagnose_subaccounts(key) if args.diagnose_subaccounts else probe(key)
    except Exception:
        print(json.dumps({'probeCompleted':False,'providerRequestsMade':False,'reason':'private_test_configuration_rejected','providerPayloadPrinted':False}))
        return 1
    print(json.dumps(report,sort_keys=True))
    if args.diagnose_subaccounts:return 0 # Diagnostic completion, not permission/merchant approval.
    return 0 if all(report[name]['accessible'] for name in ['ngBankCatalogue','collectionSubaccountList','ngnCardFeeQuote']) and not report['ngnCardFeeQuote']['unexpectedAdditionalCharge'] else 2
if __name__=='__main__':raise SystemExit(main())
