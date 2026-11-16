"""Package only the committed data-correction/activation tools; never any API, web or release SQL.
Refuses existing output paths. Run after committing: python scripts/release/package-gb-scope-fix.py
"""
from pathlib import Path
import hashlib
import io
import subprocess
import tarfile

root = Path(__file__).resolve().parents[2]
sha = subprocess.check_output(['git', 'rev-parse', '--short=7', 'HEAD'], cwd=root, text=True).strip()
name = f'vaydu-gb-scope-fix-{sha}'
archive = root / 'release' / f'{name}.tar.gz'
sidecar = archive.with_suffix(archive.suffix + '.sha256')
if archive.exists() or sidecar.exists():
    raise SystemExit('Refusing to overwrite an existing fix artifact')
files = {}
for file in ['activate-gb.sql', 'activate-gb-cash.sql', 'correct-legacy-gb-pricing.sql',
             'correct-legacy-gb-pricing.sh', 'probe-gb-ng-quotes.cjs', 'compare-legacy-pricing.cjs',
             'LEGACY-GB-SCOPE.md']:
    path = f'deploy/vaydu-develop-activation/{file}'
    files[file] = subprocess.check_output(['git', 'show', f'HEAD:{path}'], cwd=root)
files['SOURCE_SHA'] = (sha + '\n').encode()
files['FIX_SHA256SUMS'] = ''.join(hashlib.sha256(data).hexdigest() + '  ' + file + '\n'
                                 for file, data in sorted(files.items())).encode()
with tarfile.open(archive, 'x:gz') as tar:
    for file, data in sorted(files.items()):
        info = tarfile.TarInfo(name + '/' + file)
        info.size = len(data)
        info.mode = 0o644
        tar.addfile(info, io.BytesIO(data))
with tarfile.open(archive) as tar:
    packed = {m.name.split('/', 1)[1]: tar.extractfile(m).read() for m in tar.getmembers()}
    assert packed == files
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
sidecar.write_text(f'{digest}  {archive.name}\n', encoding='utf-8', newline='\n')
print(f'{digest}  {archive}')
print('FIX_ARCHIVE_CONTENTS_VERIFIED: committed tools only; API/web/release SQL excluded')
