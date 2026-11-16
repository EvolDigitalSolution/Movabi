"""Create an immutable operator artifact with an isolated, paired API-only candidate.
Keep base web/release SQL bytes and exclude unfinished branch followups.
"""
from pathlib import Path
import hashlib
import io
import json
import subprocess
import tarfile

root = Path(__file__).resolve().parents[2]
sha = subprocess.check_output(['git', 'rev-parse', '--short=7', 'HEAD'], cwd=root, text=True).strip()
name = f'vaydu-gb-p8-fix-{sha}'
archive = root / 'release' / f'{name}.tar.gz'
sidecar = archive.with_suffix(archive.suffix + '.sha256')
if archive.exists() or sidecar.exists():
    raise SystemExit('Refusing to overwrite an existing P8 artifact')

def committed(path):
    return subprocess.check_output(['git', 'show', f'HEAD:{path}'], cwd=root)

files = {}
for file in ['activate-gb.sql', 'correct-legacy-gb-pricing.sql', 'correct-gb-p8-strategies.sql',
             'activation-preflight.sql', 'p8-transaction-before.sql', 'p8-transaction-after.sql', 'preserve-platform-defaults.sql',
             'build-p8-transaction.sh', 'activate-gb-quote-tenant.sql', 'probe-p8-quotes.cjs',
             'reconcile-gb-p8.sh', 'deploy-p8-api.sh', 'P8-RECONCILIATION.md']:
    files[file] = committed(f'deploy/vaydu-develop-activation/{file}')
files['P8_VERIFY.sql'] = committed('deploy/vaydu-develop-release-2/VERIFY.sql')
api_paths = ['server/services/pricing.service.ts', 'server/services/marketplace-config.service.ts',
             'server/services/market-pricing.service.ts', 'server/services/global-ai-pricing.service.ts',
             'server/routes/global-ai-pricing.routes.ts', 'server/routes/payment.routes.ts', 'server/services/gb-quote-tenant.ts']
files['P8_API_SHA256SUMS'] = ''.join(hashlib.sha256(committed(path)).hexdigest() + '  ' + path + '\n' for path in api_paths).encode()
# Pair with an API-only candidate based on the immutable reviewed f949a14 bundle. Never
# package current branch wholesale: its unfinished P3/P10/P11/P12 work must not ship here.
base_archive = root / 'release/vaydu-develop-f949a14-release-linux.tar.gz'
assert hashlib.sha256(base_archive.read_bytes()).hexdigest() == '58dcdbaf0b27769bcf15bfbfa584e4e64002c4ab27ada42cd4f5f57cc089488a'
with tarfile.open(base_archive) as tar:
    base = {m.name.split('/', 1)[1]: tar.extractfile(m).read() for m in tar.getmembers() if m.isfile()}
    modes = {m.name.split('/', 1)[1]: m.mode for m in tar.getmembers() if m.isfile()}
for manifest in ['SHA256SUMS', 'ALL_SHA256SUMS', 'RELEASE-MIGRATIONS.sha256']:
    for line in base[manifest].decode().splitlines():
        digest, path = line.split(None, 1)
        assert hashlib.sha256(base[path.lstrip('*').removeprefix('./')]).hexdigest() == digest
candidate = dict(base)
patches = ['server/routes/global-ai-pricing.routes.ts', 'server/routes/payment.routes.ts', 'server/services/gb-quote-tenant.ts']
for path in patches:
    candidate[path] = committed(path)
for path in api_paths[:4]:
    assert candidate[path] == committed(path), f'Unexpected calculator change: {path}'
candidate['SOURCE_SHA'] = (sha + '\n').encode()
candidate['API_BASE_SOURCE'] = b'f949a14\n'
candidate['P8_API_PATCH.json'] = json.dumps({'base': 'f949a14', 'source': sha, 'patched_paths': patches,
    'web_and_release_sql': 'byte-identical to base', 'unfinished_followups': 'excluded'}, indent=2).encode() + b'\n'
for path, data in base.items():
    if path not in patches + ['SOURCE_SHA', 'SHA256SUMS', 'ALL_SHA256SUMS']:
        assert candidate[path] == data
checks = [line.split(None, 1)[1].lstrip('*').removeprefix('./') for line in base['SHA256SUMS'].decode().splitlines()]
candidate['SHA256SUMS'] = ''.join(hashlib.sha256(candidate[p]).hexdigest() + '  ' + p + '\n' for p in checks).encode()
candidate['ALL_SHA256SUMS'] = ''.join(hashlib.sha256(data).hexdigest() + '  ./' + p + '\n'
    for p, data in sorted(candidate.items()) if p not in ['SHA256SUMS', 'ALL_SHA256SUMS']).encode()
api_name = f'vaydu-develop-{sha}-release-linux'
api_buffer = io.BytesIO()
with tarfile.open(fileobj=api_buffer, mode='w:gz') as tar:
    for p, data in sorted(candidate.items()):
        info = tarfile.TarInfo(api_name + '/' + p); info.size = len(data); info.mode = modes.get(p, 0o644)
        tar.addfile(info, io.BytesIO(data))
api_data = api_buffer.getvalue()
files[api_name + '.tar.gz'] = api_data
files[api_name + '.tar.gz.sha256'] = (hashlib.sha256(api_data).hexdigest() + '  ' + api_name + '.tar.gz\n').encode()
files['SOURCE_SHA'] = (sha + '\n').encode()
files['P8_SHA256SUMS'] = ''.join(hashlib.sha256(data).hexdigest() + '  ' + file + '\n' for file, data in sorted(files.items())).encode()
with tarfile.open(archive, 'x:gz') as tar:
    for file, data in sorted(files.items()):
        info = tarfile.TarInfo(name + '/' + file)
        info.size = len(data)
        info.mode = 0o644
        tar.addfile(info, io.BytesIO(data))
with tarfile.open(archive) as tar:
    assert {m.name.split('/', 1)[1]: tar.extractfile(m).read() for m in tar.getmembers()} == files
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
sidecar.write_text(f'{digest}  {archive.name}\n', encoding='utf-8', newline='\n')
print(f'{digest}  {archive}')
print('P8_ARTIFACT_VERIFIED: operator tools + f949a14 API-only base with exactly 3 quote-tenant source changes; web/release SQL unchanged; unfinished followups excluded')
