"""Synthetic probe regression. No network requests or real credential files."""
import importlib.util
import io
import json
from pathlib import Path
from urllib.error import HTTPError
SPEC=importlib.util.spec_from_file_location('merchant_probe',Path(__file__).with_name('check-flutterwave-test-merchant.py'))
MODULE=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(MODULE)
class Response:
    def __init__(self,value):self.value=value
    def __enter__(self):return self
    def __exit__(self,*_):return False
    def read(self,_):return json.dumps(self.value).encode()
    def getcode(self):return 200
class Opener:
    def __init__(self,fail=False):self.calls=[];self.fail=fail
    def open(self,request,timeout):
        self.calls.append(request)
        assert request.method=='GET' and request.full_url.startswith('https://api.flutterwave.com/v3/')
        if self.fail:raise HTTPError(request.full_url,403,'raw sensitive provider error',None,None)
        data={'fee':1,'charge_amount':105} if '/transactions/fee?' in request.full_url else [{'account_number':'synthetic-bank-details-must-not-print','api_key':'synthetic-payload-secret'}]
        return Response({'status':'success','data':data})
opener=Opener();result=MODULE.probe('FLWSECK_TEST-synthetic',opener)
assert len(opener.calls)==3 and all(r.data is None for r in opener.calls)
text=json.dumps(result)
assert 'synthetic-bank-details' not in text and 'synthetic-payload-secret' not in text and 'FLWSECK_TEST' not in text
assert result['subaccountCreationTested'] is False and result['ngnCardFeeQuote']['unexpectedAdditionalCharge'] is False
bad=Opener()
try:MODULE.probe('FLWSECK-live',bad);raise AssertionError('Live key accepted')
except RuntimeError:pass
assert not bad.calls
denied=MODULE.probe('FLWSECK_TEST-synthetic',Opener(True))
assert denied['ngBankCatalogue']=={'accessible':False,'httpStatus':403}
assert 'raw sensitive' not in json.dumps(denied)
class DiagnosticOpener:
    def __init__(self):self.calls=[]
    def open(self,request,timeout):
        self.calls.append(request)
        body={'status':'error','code':'15404','message':'No subaccounts found',
              'data':{'account_number':'0123456789','secret':'FLWSECK_TEST-must-not-print'}}
        raise HTTPError(request.full_url,400,'must not echo',None,io.BytesIO(json.dumps(body).encode()))
diagnostic_opener=DiagnosticOpener()
diagnostic=MODULE.diagnose_subaccounts('FLWSECK_TEST-synthetic',diagnostic_opener)
assert [r.full_url for r in diagnostic_opener.calls]==['https://api.flutterwave.com/v3/subaccounts','https://api.flutterwave.com/v3/subaccounts?page=1']
assert all(r.method=='GET' and r.data is None for r in diagnostic_opener.calls)
assert diagnostic['checks'][0]['providerCode']=='15404' and diagnostic['checks'][0]['messageCategory']=='no_rows'
assert all(r['accessible'] and r['emptyList'] and r['countOnReturnedPage']==0 and not r['recreationPermitted'] for r in diagnostic['checks'])
assert '0123456789' not in json.dumps(diagnostic) and 'FLWSECK_TEST' not in json.dumps(diagnostic)
class EmptyOpener(Opener):
    def open(self,request,timeout):
        if '/subaccounts' in request.full_url:
            raise HTTPError(request.full_url,400,'withheld',None,io.BytesIO(b'{"status":"error","message":"Subaccounts not found"}'))
        return super().open(request,timeout)
assert MODULE.probe('FLWSECK_TEST-synthetic',EmptyOpener())['collectionSubaccountList']['emptyList'] is True
successful_diagnostic=MODULE.diagnose_subaccounts('FLWSECK_TEST-synthetic',Opener())
assert all(item['accessible'] and item['countOnReturnedPage']==1 for item in successful_diagnostic['checks'])
assert 'synthetic-bank-details' not in json.dumps(successful_diagnostic) and 'synthetic-payload-secret' not in json.dumps(successful_diagnostic)
for message in ['Invalid page number','No subaccounts found for account 0123456789 secret FLWSECK_TEST-hidden',
                'The account 0123456789 belongs to Person Name. Key FLWSECK_TEST-hidden',
                {'secret':'FLWSECK_TEST-hidden'}]:
    safe=MODULE.safe_provider_error(json.dumps({'code':'FLWSECK_TEST-hidden','message':message,'data':{'bank':'0123456789'}}).encode())
    text=json.dumps(safe)
    assert '0123456789' not in text and 'FLWSECK_TEST' not in text and 'Person Name' not in text
assert MODULE.safe_provider_error(b'<html>secret text</html>')['providerMessage']=='[non-JSON error body withheld]'
assert MODULE.safe_provider_error(b'x'*65537)['providerMessage']=='[oversized error body withheld]'
no_network=DiagnosticOpener()
try:MODULE.diagnose_subaccounts('FLWSECK-live',no_network);raise AssertionError('Live diagnostic key accepted')
except RuntimeError:pass
assert not no_network.calls
import os,tempfile
if hasattr(os,'getuid'):
    with tempfile.TemporaryDirectory(prefix='vaydu-merchant-probe-') as root:
        target=Path(root)/'flutterwave-test.env'
        content='FLUTTERWAVE_TEST_SECRET_KEY=FLWSECK_TEST-synthetic\nFLUTTERWAVE_LIVE_SECRET_KEY=\nVAYDU_DRIVER_SUBACCOUNT_SANDBOX=false\nVAYDU_FLUTTERWAVE_BOOKING_SPLIT_SANDBOX=false\nVAYDU_BOOKING_SPLIT_TIMING_APPROVED=false\n'
        target.write_text(content);os.chmod(target,0o600)
        assert MODULE.load_test_key(target)=='FLWSECK_TEST-synthetic'
        os.chmod(target,0o644)
        try:MODULE.load_test_key(target);raise AssertionError('Public credential file accepted')
        except RuntimeError:pass
        os.chmod(target,0o600);target.write_text(content+'SUPABASE_SERVICE_ROLE_KEY=synthetic-not-to-be-read-as-a-provider-file\n')
        try:MODULE.load_test_key(target);raise AssertionError('DB credential file accepted')
        except RuntimeError:pass
print('PASS: GET-only test-key probe, live rejection before network, bank/key payload suppression, bounded and sanitized errors')
