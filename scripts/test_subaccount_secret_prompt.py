"""Linux PTY test with synthetic keys only; no network or DB access."""
import os
from pathlib import Path
import pty
import select
import signal
import tempfile
import time
from provision_flutterwave_subaccount_test import provision

def case(key,success):
    root=Path(tempfile.mkdtemp(prefix='vaydu-subaccount-prompt-'))
    pid,fd=pty.fork()
    if pid==0:
        try:provision(root);os._exit(0)
        except Exception:os._exit(1)
    transcript=b'';index=0;deadline=time.time()+20
    prompts=[(b'TEST secret key (hidden): ',key),(b'merchant reference (hidden): ',b'synthetic-merchant')]
    while time.time()<deadline:
        ready,_,_=select.select([fd],[],[],.5)
        if not ready:continue
        try:chunk=os.read(fd,65536)
        except OSError:break
        if not chunk:break
        transcript+=chunk
        if index<len(prompts) and prompts[index][0] in transcript:
            os.write(fd,prompts[index][1]+b'\n');index+=1
    if time.time()>=deadline:os.kill(pid,signal.SIGTERM)
    _,status=os.waitpid(pid,0);os.close(fd)
    assert key not in transcript and b'synthetic-merchant' not in transcript,'Hidden input echoed'
    assert (os.waitstatus_to_exitcode(status)==0)==success
    target=root/'flutterwave-test.env'
    if success:
        assert target.stat().st_mode&0o777==0o600
        data=target.read_text()
        assert 'VAYDU_DRIVER_SUBACCOUNT_SANDBOX=false' in data
        assert 'VAYDU_FLUTTERWAVE_BOOKING_SPLIT_SANDBOX=false' in data
        assert 'FLUTTERWAVE_LIVE_SECRET_KEY=\n' in data
        assert 'SUPABASE_' not in data and 'POSTGRES_' not in data
        target.unlink()
    else:assert not target.exists()
    root.rmdir()
case(b'FLWSECK_TEST-synthetic',True)
case(b'FLWSECK-live-synthetic',False)
print('PASS: hidden non-seekable SSH-style PTY, 0600 outside Git, live key rejected, gates false, no DB credentials or requests')
