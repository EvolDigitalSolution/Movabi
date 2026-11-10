"""Disposable real Auth/PostgREST/Postgres; synthetic credentials, mocked provider only."""
import argparse, base64, hashlib, hmac, http.server, json, os, shutil, subprocess, tempfile, threading, time, uuid
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent
DRIVER='318e6be9-9164-41fa-bb0c-c5ccd3526585'
TENANT='d0e8e8e8-e8e8-e8e8-e8e8-d0e8e8e8e8e8'
SECRET='disposable-integration-jwt-secret-never-a-real-key'
PREFIX='vaydu-onboard-test-'+uuid.uuid4().hex[:8]
DOCKER=['docker']

def cmd(args,data=None,check=True):
 if args and args[0]=='docker':args=DOCKER+args[1:]
 p=subprocess.run(args,input=data,capture_output=True,timeout=180)
 if check and p.returncode:raise RuntimeError('fixture_command_failed:'+Path(args[0]).name+':'+str(p.returncode))
 return p
def docker(*args,data=None):return cmd(['docker',*args],data).stdout.decode().strip()
def sql(s):return docker('exec','-i',PREFIX+'-db','psql','-U','postgres','-d','movabi_develop','-XqAt','-v','ON_ERROR_STOP=1',data=s.encode())
def token(role,sub=None):
 def b(value):return base64.urlsafe_b64encode(json.dumps(value,separators=(',',':')).encode()).rstrip(b'=')
 data=b({'alg':'HS256','typ':'JWT'})+b'.'+b({'role':role,'aud':'authenticated','exp':int(time.time())+1800,**({'sub':sub} if sub else {})})
 return (data+b'.'+base64.urlsafe_b64encode(hmac.new(SECRET.encode(),data,hashlib.sha256).digest()).rstrip(b'=')).decode()
def port(container,number):return int(docker('port',container,str(number)+'/tcp').rsplit(':',1)[1])
def wait(fn):
 for _ in range(90):
  try:return fn()
  except Exception:time.sleep(.5)
 raise RuntimeError('fixture_start_timeout')

def main():
 global DOCKER
 parser=argparse.ArgumentParser();parser.add_argument('--image');args=parser.parse_args()
 if subprocess.run(['docker','info','--format','{{.ServerVersion}}'],capture_output=True).returncode:DOCKER=['sudo','-n','docker']
 temp=Path(tempfile.mkdtemp(prefix='vaydu-onboarding-integration-'));server=None
 try:
  os.chmod(temp,0o700);docker('network','create',PREFIX)
  docker('run','-d','--name',PREFIX+'-db','--network',PREFIX,'-e','PGDATA=/tmp/vaydu-restore','-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_DB=movabi_develop','postgres:15')
  wait(lambda:sql('SELECT 1'))
  sql((ROOT/'sql/fixture.sql').read_text())
  sql("ALTER ROLE service_role BYPASSRLS;CREATE ROLE authenticator LOGIN;GRANT anon,authenticated,service_role TO authenticator;GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;GRANT SELECT ON profiles,market_availability TO service_role;CREATE SCHEMA auth;CREATE EXTENSION IF NOT EXISTS pgcrypto;ALTER TABLE profiles ADD onboarding_completed boolean DEFAULT false,ADD identity_verified boolean DEFAULT false;")
  sql((ROOT/'tests/onboarding-fixture.sql').read_text())
  docker('run','-d','--name',PREFIX+'-auth','--network',PREFIX,'-p','127.0.0.1::9999',
   '-e','GOTRUE_DB_DRIVER=postgres','-e',f'DATABASE_URL=postgres://postgres@{PREFIX}-db:5432/movabi_develop?search_path=auth',
   '-e','GOTRUE_API_HOST=0.0.0.0','-e','GOTRUE_API_PORT=9999','-e','API_EXTERNAL_URL=http://localhost:9999',
   '-e','GOTRUE_SITE_URL=http://localhost','-e','GOTRUE_JWT_SECRET='+SECRET,'-e','GOTRUE_JWT_ADMIN_ROLES=service_role',
   '-e','GOTRUE_JWT_AUD=authenticated','supabase/gotrue:v2.132.3')
  import urllib.request
  auth_port=port(PREFIX+'-auth',9999)
  def health():
   with urllib.request.urlopen(f'http://127.0.0.1:{auth_port}/health',timeout=2) as r:
    if r.status!=200:raise RuntimeError()
  wait(health)
  customer='11111111-1111-4111-8111-111111111111';foreign='22222222-2222-4222-8222-222222222222'
  for id,role,tenant in [(DRIVER,'driver',TENANT),(customer,'customer',TENANT),(foreign,'driver','33333333-3333-4333-8333-333333333333')]:
   request=urllib.request.Request(f'http://127.0.0.1:{auth_port}/admin/users',data=json.dumps({'id':id,'email':id+'@example.invalid','email_confirm':True,'password':'Synthetic-password-never-real-123!'}).encode(),headers={'Authorization':'Bearer '+token('service_role'),'Content-Type':'application/json'},method='POST')
   with urllib.request.urlopen(request,timeout=10) as response:created=json.load(response)['id']
   # GoTrue 2.132 assigns the UUID. Copy its fully initialized synthetic row
   # to the approved fixture UUID (excluding generated columns), not a partial
   # hand-written auth row with NULL defaults. No real Auth data is involved.
   if created!=id:
    sql("DO $$ DECLARE cols text;BEGIN SELECT string_agg(quote_ident(attname),',' ORDER BY attnum) INTO cols FROM pg_attribute WHERE attrelid='auth.users'::regclass AND attnum>0 AND NOT attisdropped AND attgenerated='';EXECUTE format('INSERT INTO auth.users(%s) SELECT %s FROM jsonb_populate_record(NULL::auth.users,(SELECT to_jsonb(u)||jsonb_build_object(''id'',%L,''email'',%L) FROM auth.users u WHERE id=%L))',cols,cols,'"+id+"','"+id+"-fixed@example.invalid','"+created+"');END $$;")
   sql(f"INSERT INTO public.profiles(id,tenant_id,role,registration_activated_at,registration_country_code,country_code) VALUES('{id}','{tenant}','{role}',now(),'NG','NG') ON CONFLICT(id) DO NOTHING;")
  variables=['-v','driver='+DRIVER,'-v','tenant='+TENANT,'-v','merchant=fixture-merchant','-v','evidence=fixture-only']
  # Refuse a partial v1 installation; rollback must leave the partial evidence.
  sql('CREATE TABLE public.driver_payout_markets(partial_fixture boolean);')
  attempt=cmd(['docker','exec','-i',PREFIX+'-db','psql','-U','postgres','-d','movabi_develop','-XqAt','-v','ON_ERROR_STOP=1',*variables],(ROOT/'sql/payment_account_setup_canonical.sql').read_bytes(),check=False)
  if attempt.returncode==0:raise RuntimeError('partial_install_must_refuse')
  if sql("SELECT to_regclass('public.driver_payment_accounts') IS NULL")!='t':raise RuntimeError('partial_install_wrote_objects')
  sql('DROP TABLE public.driver_payout_markets;')
  for name in ['payment_account_setup_canonical.sql','payment_account_recovery_v2.sql']:
   if name=='payment_account_recovery_v2.sql':
    sql("CREATE FUNCTION public.bind_driver_payment_recovery(uuid,text,text) RETURNS boolean LANGUAGE sql AS 'SELECT false';")
    partial=cmd(['docker','exec','-i',PREFIX+'-db','psql','-U','postgres','-d','movabi_develop','-XqAt','-v','ON_ERROR_STOP=1',*variables],(ROOT/'sql'/name).read_bytes(),check=False)
    if partial.returncode==0:raise RuntimeError('partial_recovery_install_must_refuse')
    if sql("SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='driver_payment_accounts' AND column_name='recovery_evidence_ref'")!='0':raise RuntimeError('partial_recovery_install_changed_schema')
    sql('DROP FUNCTION public.bind_driver_payment_recovery(uuid,text,text);')
   docker('exec','-i',PREFIX+'-db','psql','-U','postgres','-d','movabi_develop','-XqAt','-v','ON_ERROR_STOP=1',*variables,data=(ROOT/'sql'/name).read_bytes())
   repeated=cmd(['docker','exec','-i',PREFIX+'-db','psql','-U','postgres','-d','movabi_develop','-XqAt','-v','ON_ERROR_STOP=1',*variables],(ROOT/'sql'/name).read_bytes(),check=False)
   if repeated.returncode==0:raise RuntimeError('repeat_install_must_refuse:'+name)
  sql((ROOT/'sql/rehearsal_assert.sql').read_text())
  docker('run','-d','--name',PREFIX+'-rest','--network',PREFIX,'-p','127.0.0.1::3000',
   '-e',f'PGRST_DB_URI=postgres://authenticator@{PREFIX}-db:5432/movabi_develop','-e','PGRST_DB_SCHEMAS=public','-e','PGRST_DB_ANON_ROLE=anon','-e','PGRST_JWT_SECRET='+SECRET,'postgrest/postgrest:v10.1.2')
  rest_port=port(PREFIX+'-rest',3000)
  def rest_health():
   with urllib.request.urlopen(f'http://127.0.0.1:{rest_port}/',timeout=2) as r:
    if r.status!=200:raise RuntimeError()
  wait(rest_health)
  class Control(http.server.BaseHTTPRequestHandler):
   def do_POST(self):
    try:
     body=sql(self.rfile.read(int(self.headers['Content-Length'])).decode()).encode();self.send_response(200);self.end_headers();self.wfile.write(body)
    except Exception:self.send_response(500);self.end_headers()
   def log_message(self,*a):pass
  server=http.server.HTTPServer(('127.0.0.1',0),Control);threading.Thread(target=server.serve_forever,daemon=True).start()
  cfg={'authPort':auth_port,'restPort':rest_port,'serviceKey':token('service_role'),'driverToken':token('authenticated',DRIVER),'customerToken':token('authenticated',customer),'foreignToken':token('authenticated',foreign),'control':'http://127.0.0.1:'+str(server.server_port)}
  if args.image:cfg.update(closureRoot='/app/server/payment-account-closure',authHost=PREFIX+'-auth',restHost=PREFIX+'-rest',authPort=9999,restPort=3000,control='http://'+PREFIX+'-rest:3000/rpc/fixture_control',controlRpc=True,integrationHashes={f['path']:f['afterSha256'] for f in json.loads((ROOT/'integration-plan.json').read_text())['files']})
  config=temp/'fixture.json';config.write_text(json.dumps(cfg));os.chmod(config,0o600)
  if args.image:
   command=['docker','run','--rm','--network',PREFIX,'--entrypoint','node','-v',str(ROOT)+':/app/setup-review:ro','-v',str(config)+':/fixture.json:ro',args.image,'/app/setup-review/tests/http-integration.cjs','/fixture.json']
  else:command=['node',str(ROOT/'tests/http-integration.cjs'),str(config)]
  result=cmd(command,check=False)
  if result.returncode:
   # Only our own fixed assertion messages are emitted, never stack/config.
   evidence=Path(tempfile.mkdtemp(prefix='vaydu-onboarding-http-failure-'));os.chmod(evidence,0o700)
   log=evidence/'assertion.log';log.write_bytes(result.stderr);os.chmod(log,0o600)
   text=result.stderr.decode(errors='replace').splitlines()
   print(json.dumps({'completed':False,'stage':'packaged-http','assertion':next((s[:180] for s in text if s.startswith('integration_failed:')),'runner_failed'),'privateFixtureEvidence':str(evidence),'privateFixtureRemoved':True}));return 1
  print(result.stdout.decode().strip());return 0
 except Exception:
  # Fixture-only logs contain synthetic values; retain privately for diagnosis.
  evidence=Path(tempfile.mkdtemp(prefix='vaydu-onboarding-failure-'));os.chmod(evidence,0o700)
  for suffix in ['-auth','-rest','-db']:
   p=cmd(['docker','logs',PREFIX+suffix],check=False)
   f=evidence/(suffix[1:]+'.log');f.write_bytes(p.stdout+p.stderr);os.chmod(f,0o600)
  print(json.dumps({'completed':False,'privateFixtureEvidence':str(evidence)}));raise
 finally:
  if server:server.shutdown()
  for suffix in ['-rest','-auth','-db']:cmd(['docker','rm','-f',PREFIX+suffix],check=False)
  cmd(['docker','network','rm',PREFIX],check=False)
  shutil.rmtree(temp)
if __name__=='__main__':raise SystemExit(main())
