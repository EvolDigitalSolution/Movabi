import importlib.util,json,subprocess,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('identity',Path(__file__).with_name('verify-flutterwave-test-account-identity.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class IdentityTests(unittest.TestCase):
 def result(self,account=123):return {'status':'success','data':{'id':456,'tx_ref':'own-test-ref','account_id':account,'currency':'NGN','payment_type':'card','card':{'token':'PRIVATE_SENTINEL'},'customer':{'email':'PRIVATE_SENTINEL'}}}
 def test_equal_numbers_are_not_automatic_approval(self):
  r=m.evidence(self.result(),'123','456','own-test-ref');self.assertTrue(r['midEqualsTransactionAccountId']);self.assertFalse(r['merchantIdentityApproved']);self.assertFalse(r['providerAccountBindingApproved'])
 def test_different_ids_are_preserved_not_assumed_equal_or_rejected(self):
  r=m.evidence(self.result(789),'123','456','own-test-ref');self.assertFalse(r['midEqualsTransactionAccountId']);self.assertEqual(r['transactionAccountId'],'789');self.assertFalse(r['walletBindingsChanged'])
 def test_only_selected_transaction_is_accepted(self):
  for txid,ref in [('999','own-test-ref'),('456','another')]:
   with self.assertRaisesRegex(RuntimeError,'identity_mismatch'):m.evidence(self.result(),'123',txid,ref)
 def test_missing_or_invalid_account_does_not_become_merchant_id(self):
  for value in [None,0,True,'alias']:
   with self.assertRaises(RuntimeError):m.evidence(self.result(value),'123','456','own-test-ref')
 def test_no_customer_card_or_raw_data_in_report(self):
  r=json.dumps(m.evidence(self.result(),'123','456','own-test-ref'));self.assertNotIn('PRIVATE_SENTINEL',r);self.assertNotIn('own-test-ref',r)
 def test_subaccount_binding_never_silently_read(self):
  with patch.object(m.os,'open') as opened:
   with self.assertRaisesRegex(RuntimeError,'not_a_wallet_binding'):m.read_wallet_key('/private/subaccount/flutterwave-test.env')
   opened.assert_not_called()
if __name__=='__main__':unittest.main()
