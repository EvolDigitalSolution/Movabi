"""GET-only identity evidence from one operator-selected existing TEST transaction.
Never creates transactions, subaccounts or transfers. Never modifies bindings/evidence.
"""
import argparse,getpass,json,os,re,stat,sys,warnings
from pathlib import Path
import urllib.request,urllib.error

def evidence(result,mid,txid,txref):
 data=result.get('data')
 if result.get('status')!='success' or not isinstance(data,dict):raise RuntimeError('verification_response_not_success')
 if str(data.get('id'))!=txid or data.get('tx_ref')!=txref:raise RuntimeError('selected_transaction_identity_mismatch')
 account=str(data.get('account_id',''))
 if not re.fullmatch(r'[0-9]{1,30}',account) or int(account)<=0:raise RuntimeError('transaction_account_id_missing_or_invalid')
 return {'completed':True,'testMerchantIdProvided':mid,'transactionId':txid,'transactionAccountId':account,'midEqualsTransactionAccountId':mid==account,'selectedTransactionIdMatched':True,'selectedTransactionReferenceMatched':True,'transactionCurrencyIsNGN':data.get('currency')=='NGN','transactionMethodIsCard':data.get('payment_type')=='card','mappingStatus':'account_id_observed_dashboard_business_mapping_review_required','merchantIdentityApproved':False,'providerAccountBindingApproved':False,'walletBindingsChanged':False,'providerRequestMethod':'GET','paymentCreated':False,'subaccountCreated':False,'transferInitiated':False}

def read_wallet_key(path):
 path=Path(path)
 if 'subaccount' in str(path).lower():raise RuntimeError('subaccount_configuration_not_a_wallet_binding')
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  info=os.fstat(fd)
  if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode)!=0o600 or info.st_uid!=os.getuid() or info.st_size>16384:raise RuntimeError('wallet_binding_permissions_or_owner_invalid')
  with os.fdopen(fd,'r',closefd=False) as stream:lines=stream.read(16385).splitlines()
 finally:os.close(fd)
 allowed={'VAYDU_DRIVER_TOPUP_API','FLUTTERWAVE_SECRET_KEY','FLUTTERWAVE_WEBHOOK_SECRET','FLUTTERWAVE_MERCHANT_REF','FLUTTERWAVE_PROVIDER_ACCOUNT_ID','VAYDU_TOPUP_CALLBACK_URL','FLUTTERWAVE_LIVE_SECRET_KEY'};values={}
 for line in lines:
  if not line or line.startswith('#'):continue
  name,sep,value=line.partition('=')
  if not sep or name not in allowed or name in values:raise RuntimeError('unexpected_wallet_binding_format')
  values[name]=value
 if values.get('FLUTTERWAVE_LIVE_SECRET_KEY'):raise RuntimeError('live_key_rejected')
 return values.get('FLUTTERWAVE_SECRET_KEY','')

def main():
 parser=argparse.ArgumentParser();source=parser.add_mutually_exclusive_group(required=True);source.add_argument('--wallet-file');source.add_argument('--private-key-prompt',action='store_true');args=parser.parse_args()
 if not sys.stdin.isatty():raise RuntimeError('interactive_ssh_terminal_required')
 mid=input('TEST dashboard Merchant ID (non-secret): ').strip()
 txid=input('Existing TEST transaction ID from that SAME dashboard business (non-secret): ').strip()
 txref=input('That transaction exact tx_ref (never bank/card details): ').strip()
 if not re.fullmatch(r'[0-9]{1,30}',mid) or not re.fullmatch(r'[0-9]{1,30}',txid) or not txref or len(txref)>255:raise RuntimeError('selected_identity_inputs_invalid')
 if args.wallet_file:key=read_wallet_key(args.wallet_file)
 else:
  warnings.simplefilter('error',getpass.GetPassWarning)
  key=getpass.getpass('Existing TEST key (hidden, memory only; no file created): ')
 if not re.fullmatch(r'FLWSECK_TEST-[A-Za-z0-9_-]+',key):raise RuntimeError('test_key_format_required_no_provider_request')
 class NoRedirect(urllib.request.HTTPRedirectHandler):
  def redirect_request(self,*a,**kw):return None
 request=urllib.request.Request('https://api.flutterwave.com/v3/transactions/'+txid+'/verify',headers={'Authorization':'Bearer '+key,'Accept':'application/json'},method='GET')
 try:
  with urllib.request.build_opener(NoRedirect()).open(request,timeout=20) as response:raw=response.read(1048577)
 except urllib.error.HTTPError as error:
  category={401:'test_authentication_rejected',403:'verification_not_authorized',404:'selected_transaction_not_available'}.get(error.code,'provider_verification_failed')
  print(json.dumps({'completed':False,'httpStatus':error.code,'category':category,'rawResponseWithheld':True,'providerRequestMethod':'GET'}));return 1
 if len(raw)>1048576:raise RuntimeError('provider_response_too_large')
 result=evidence(json.loads(raw),mid,txid,txref);result['testKeyFormatConfirmed']=True;result['testKeyAcceptedByVerificationEndpoint']=True
 print(json.dumps(result,sort_keys=True));return 0
if __name__=='__main__':
 try:raise SystemExit(main())
 except Exception as error:
  reason=str(error) if type(error) is RuntimeError else 'identity_probe_failed_raw_output_withheld'
  print(json.dumps({'completed':False,'category':reason,'noSecretValuesPrinted':True}));raise SystemExit(1)
