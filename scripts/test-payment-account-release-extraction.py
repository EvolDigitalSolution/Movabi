"""Test a temporary extracted draft, without publishing an operator bundle."""
import hashlib,importlib.util,json,shutil,tarfile,tempfile
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent/'deploy/vaydu-payment-account-setup'
def main():
 with tempfile.TemporaryDirectory(prefix='vaydu-extraction-test-') as temp:
  temp=Path(temp);staged=temp/'staged';staged.mkdir()
  for name in ['Dockerfile.api','patch-entry.cjs','integration-plan.json','merchant-evidence.template.json','release.json','reviewed-protected.json','BASELINE_REVIEW.md','RUNBOOK.md']:shutil.copyfile(ROOT/name,staged/name)
  for name in ['api','baseline','operator','sql','tests']:shutil.copytree(ROOT/name,staged/name,ignore=shutil.ignore_patterns('__pycache__'))
  files=sorted(p for p in staged.rglob('*') if p.is_file())
  manifest=''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.relative_to(staged).as_posix()+'\n' for p in files)
  (staged/'manifest.sha256').write_text(manifest)
  archive=temp/'internal-test-only.tar.gz'
  with tarfile.open(archive,'w:gz') as tar:
   for p in sorted(staged.rglob('*')):
    if p.is_file():tar.add(p,arcname=p.relative_to(staged),recursive=False)
  extracted=temp/'extracted';extracted.mkdir()
  with tarfile.open(archive) as tar:tar.extractall(extracted,filter='data')
  spec=importlib.util.spec_from_file_location('extracted_operator',extracted/'operator/payment_account_operator.py')
  op=importlib.util.module_from_spec(spec);spec.loader.exec_module(op)
  release=op.load_release()
  assert release['onboardingIntegrationReviewed'] is True and release['setupEvidenceApproved'] is False
  assert len(op.API_FILES)==7
  candidate=extracted/'api/onboarding/router.js';original=candidate.read_bytes();candidate.write_bytes(original+b'\n// tampered')
  try:op.load_release();raise AssertionError('tampered release accepted')
  except op.Blocked as e:assert 'checksum_mismatch' in str(e)
  candidate.write_bytes(original);op.load_release()
  (extracted/'unexpected.env').write_text('fixture-only')
  try:op.load_release();raise AssertionError('unlisted file accepted')
  except op.Blocked as e:assert 'manifest_incomplete' in str(e)
  print(json.dumps({'extractedManifestVerified':True,'apiFiles':7,'tamperingRejected':True,'unlistedFilesRejected':True,'activationStillGated':True,'publishedBundle':False,'actualPinnedImageTested':False}))
if __name__=='__main__':main()
