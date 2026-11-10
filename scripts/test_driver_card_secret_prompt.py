"""Linux PTY regression. Synthetic inputs only; network access is never used."""
import json,os,pathlib,pty,select,tempfile,time,signal
from provision_driver_card_secrets import provision,CALLBACK,fee_probe
from unittest.mock import patch
with patch('urllib.request.build_opener') as network:
    try:fee_probe('FLWSECK-live-synthetic');raise AssertionError('Live key accepted')
    except RuntimeError:pass
    assert not network.called,'Provider request attempted before test-mode validation'
root=pathlib.Path(tempfile.mkdtemp(prefix='vaydu-secret-prompt-fixture-'))
pid,fd=pty.fork()
if pid==0:
    try:provision(root=root,probe=lambda _secret:{'charge_amount':'105','currency':'NGN'});os._exit(0)
    except Exception:os._exit(1)
prompts=[(b'TEST secret key (hidden): ',b'FLWSECK_TEST-synthetic'),(b'webhook secret (hidden): ',b'synthetic-webhook'),(b'merchant reference (hidden): ',b'synthetic-merchant'),(b'digits (hidden): ',b'17321'),(('Approved callback URL (hidden; use '+CALLBACK+'): ').encode(),CALLBACK.encode())]
transcript=b'';index=0;deadline=time.time()+30
while time.time()<deadline:
    ready,_,_=select.select([fd],[],[],1)
    if not ready:continue
    try:chunk=os.read(fd,65536)
    except OSError:break
    if not chunk:break
    transcript+=chunk
    if index<len(prompts) and prompts[index][0] in transcript:
        os.write(fd,prompts[index][1]+b'\n');index+=1
if time.time()>=deadline:os.kill(pid,signal.SIGTERM)
_,status=os.waitpid(pid,0);os.close(fd)
assert os.waitstatus_to_exitcode(status)==0,'TTY provisioning failed'
assert index==len(prompts),'A hidden prompt was missed'
for secret in [b'FLWSECK_TEST-synthetic',b'synthetic-webhook',b'synthetic-merchant']:
    assert secret not in transcript,'Synthetic secret was echoed'
target=root/'flutterwave-test.env'
assert target.exists() and target.stat().st_mode&0o777==0o600
content=target.read_text();assert 'VAYDU_DRIVER_TOPUP_API=false' in content and 'FLUTTERWAVE_PROVIDER_ACCOUNT_ID=17321' in content
target.unlink();root.rmdir()
print('PASS: non-seekable PTY, hidden inputs, test-only validation, private 0600 storage, no secret echo, collection stays off')
