"""Allowlisted develop source export; all subprocess diagnostics are value-free.

Reads present files from the eight-path allowlist, container identity and metadata. Writes
private review artifacts only. No Env, credentials, DB access or service changes.
"""
import base64
import hashlib
import io
import json
import os
import re
import stat
import subprocess
import tarfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

PATHS = ['server/routes/connect.routes.ts', 'server/services/stripe.service.ts',
         'server/routes/booking.routes.ts', 'server/services/job-payout.service.ts',
         'server/services/payout-eligibility.service.ts', 'server/routes/payment.routes.ts',
         'server/services/payments/stripe-payment-adapter.ts',
         'server/services/payments/stripe-payment-bridge.ts']
OPTIONAL_ABSENT = frozenset(PATHS[-2:])
OUT = Path.home() / 'vaydu-source-review-20261028'
CONTAINER = 'movabi-develop-api'
MAX_SOURCE = 2097152


class SafeFailure(Exception):
    def __init__(self, stage, executable, exit_code, category, context=None):
        self.diagnostic = {'stage': stage, 'executable': executable,
                           'exitCode': exit_code, 'category': category,
                           'containerExists': (context or {}).get('containerExists'),
                           'sourcePathExists': (context or {}).get('sourcePathExists')}
        super().__init__(category)


def category(stderr):
    """Classify internally; never return an excerpt, token, path or raw message."""
    text = stderr.decode('utf-8', errors='replace').lower() if isinstance(stderr, bytes) else ''
    for name, fragments in [
        ('docker_daemon_unavailable', ('cannot connect to the docker daemon', 'is the docker daemon running', 'error during connect', 'connection refused')),
        ('sudo_noninteractive_auth_required', ('a password is required', 'no tty present', 'a terminal is required')),
        ('permission_denied', ('permission denied', 'not allowed to execute', 'not in the sudoers')),
        ('container_not_found', ('no such container', 'no such object')),
        ('container_not_running', ('is not running',)),
        ('node_executable_missing', ('executable file not found', 'exec: "node"', "exec: 'node'")),
        ('inspect_template_unsupported', ('template parsing error', 'template execution error')),
    ]:
        if any(fragment in text for fragment in fragments):
            return name
    return 'command_failed_unclassified'


def run(stage, args, context=None, node_codes=None):
    executable = Path(args[0]).name
    try:
        result = subprocess.run(args, capture_output=True, timeout=40)
    except subprocess.TimeoutExpired:
        raise SafeFailure(stage, executable, None, 'command_timeout', context) from None
    except FileNotFoundError:
        raise SafeFailure(stage, executable, None, 'executable_not_found', context) from None
    except PermissionError:
        raise SafeFailure(stage, executable, None, 'executable_permission_denied', context) from None
    except OSError:
        raise SafeFailure(stage, executable, None, 'command_launch_failed', context) from None
    if result.returncode:
        reason = (node_codes or {}).get(result.returncode) or category(result.stderr)
        ctx = dict(context or {})
        if reason == 'container_not_found':
            ctx['containerExists'] = False
        raise SafeFailure(stage, executable, result.returncode, reason, ctx)
    return result.stdout


def decode_json(raw, stage, context):
    try:
        return json.loads(raw)
    except (ValueError, UnicodeError):
        raise SafeFailure(stage, 'docker', 0, 'unexpected_command_response', context) from None


def checked_text(raw, stage, context):
    try:
        return raw.decode('utf-8').strip()
    except UnicodeError:
        raise SafeFailure(stage, 'docker', 0, 'unexpected_command_response', context) from None


def source_probe_code():
    return """const fs=require('fs');const paths=__PATHS__;const out={};
for(const p of paths){const f='/app/'+p;let exists=null,safe=false;
try{const s=fs.lstatSync(f);exists=true;safe=s.isFile()&&!s.isSymbolicLink()&&s.size<=2097152&&fs.realpathSync(f)===f;}
catch(e){if(e.code==='ENOENT')exists=false;}
out[p]={exists,safe};}process.stdout.write(JSON.stringify(out));""".replace('__PATHS__', json.dumps(PATHS))


def source_export_code():
    # Re-check path safety immediately before reading. Codes contain no raw text.
    return """const fs=require('fs');const paths=__PATHS__;const optional=__OPTIONAL__;const out={};
for(const p of paths){const f='/app/'+p;try{const s=fs.lstatSync(f);
if(!s.isFile()||s.isSymbolicLink()||s.size>2097152||fs.realpathSync(f)!==f)process.exit(21);
out[p]={exists:true,content:fs.readFileSync(f).toString('base64')};}
catch(e){if(e.code==='ENOENT'&&optional.includes(p)){out[p]={exists:false};continue;}if(e.code==='ENOENT'||e.code==='ENOTDIR')process.exit(20);if(e.code==='EACCES'||e.code==='EPERM')process.exit(22);process.exit(23);}}
process.stdout.write(JSON.stringify(out));""".replace('__PATHS__', json.dumps(PATHS)).replace('__OPTIONAL__',json.dumps(sorted(OPTIONAL_ABSENT)))


def inventory():
    found, denied, scanned = [], [], 0
    for root in [Path.home()/'.config', Path('/opt'), Path('/srv'), Path('/etc/vaydu')]:
        if not root.exists() or root.is_symlink():
            continue
        def error(e):
            denied.append(str(e.filename))
        for directory, dirs, files in os.walk(root, followlinks=False, onerror=error):
            relative = Path(directory).relative_to(root)
            dirs[:] = [name for name in dirs if name not in {'.git', 'node_modules', 'backups', 'vaydu-develop-wallet-backups'}
                       and not (Path(directory)/name).is_symlink() and len(relative.parts)<5]
            for name in files:
                scanned += 1
                if scanned > 30000:
                    raise SafeFailure('wallet_filename_inventory', 'python3', None, 'filename_inventory_limit_exceeded')
                full = Path(directory)/name
                low = str(full).lower()
                if not any(word in low for word in ('flutterwave', 'wallet', 'driver-card')) or not name.endswith(('.env', '.env.test', '.env.sandbox')):
                    continue
                try:
                    info = full.lstat()
                except OSError:
                    denied.append(str(full))
                    continue
                found.append({'path': str(full), 'uid': info.st_uid, 'gid': info.st_gid,
                              'mode': format(stat.S_IMODE(info.st_mode), '04o'),
                              'regularFile': stat.S_ISREG(info.st_mode), 'symlink': stat.S_ISLNK(info.st_mode),
                              'subaccountFileExcluded': 'subaccount' in low, 'candidateOnly': True})
    return found, denied


def previous_evidence():
    """Classify only known export artifacts; never delete or overwrite them."""
    results = []
    candidates = [OUT] + sorted(OUT.parent.glob(OUT.name+'-run-*'))[:100]
    for folder in candidates:
        if not folder.exists() and not folder.is_symlink():
            continue
        state = 'incomplete_or_legacy_unconfirmed_preserved'
        if folder.is_symlink() or not folder.is_dir():
            state = 'unsafe_path_preserved'
        else:
            marker, archive = folder/'completion.json', folder/'export.tar.gz'
            try:
                if marker.is_file() and not marker.is_symlink() and marker.stat().st_size <= 65536:
                    item = json.loads(marker.read_text())
                    if (item.get('completed') is True and archive.is_file() and not archive.is_symlink()
                            and archive.stat().st_size <= 8*MAX_SOURCE+1048576
                            and hashlib.sha256(archive.read_bytes()).hexdigest() == item.get('archiveSha256')):
                        state = 'completed_verified_preserved'
                    else:
                        state = 'completion_evidence_invalid_preserved'
                elif archive.is_file() and not archive.is_symlink() and archive.stat().st_size <= 8*MAX_SOURCE+1048576:
                    # Old helper had no completion marker. Verify archive members,
                    # but do not infer the entire old run completed successfully.
                    with tarfile.open(archive, 'r:gz') as tf:
                        members = tf.getmembers()
                        if (len(members) == 9 and {m.name for m in members} == set(PATHS)|{'source-review.json'}
                                and all(m.isfile() and m.size <= MAX_SOURCE for m in members)):
                            state = 'legacy_archive_present_run_completion_unknown_preserved'
            except (OSError, ValueError, tarfile.TarError):
                state = 'incomplete_or_unreadable_preserved'
        results.append({'directory': str(folder), 'state': state})
    return results


def write_export(data, image, prior):
    folder = OUT.with_name(OUT.name+'-run-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+uuid.uuid4().hex[:8])
    # Exclusive directory creation. A failed directory is retained; never reused.
    folder.mkdir(mode=0o700)
    archive = folder/'export.tar.gz'
    partial = folder/'export.tar.gz.partial'
    hashes = {}
    with partial.open('xb') as raw:
        os.chmod(partial, 0o600)
        with tarfile.open(fileobj=raw, mode='w:gz') as tf:
            for name in PATHS:
                if name not in data:continue
                content = data[name]
                hashes[name] = hashlib.sha256(content).hexdigest()
                entry = tarfile.TarInfo(name)
                entry.size, entry.mode = len(content), 0o600
                tf.addfile(entry, io.BytesIO(content))
            metadata = json.dumps({'formatVersion':2,'composeProject':'movabi-develop','image':image,'files':{name:({'exists':True,'sha256':hashes[name]} if name in hashes else {'exists':False}) for name in PATHS}}, indent=2).encode()
            entry = tarfile.TarInfo('source-review.json')
            entry.size, entry.mode = len(metadata), 0o600
            tf.addfile(entry, io.BytesIO(metadata))
        raw.flush()
        os.fsync(raw.fileno())
    # This is a freshly created unique directory, no successful evidence is replaced.
    partial.rename(archive)
    result = {'completed':True, 'sourceArchive':str(archive),
              'archiveSha256':hashlib.sha256(archive.read_bytes()).hexdigest(),
              'exportedSourceFiles':[p for p in PATHS if p in data],'absentSourceFiles':[p for p in PATHS if p not in data], 'sourceImage':image, 'previousExports':prior}
    return folder, result


def main():
    context = {'containerExists':None, 'sourcePathExists':None}
    diagnostics = []
    stage = 'docker_access_direct'
    try:
        d = ['docker']
        try:
            run(stage, d+['info','--format','{{.ServerVersion}}'], context)
        except SafeFailure as direct:
            diagnostics.append(direct.diagnostic)
            d = ['sudo','-n','docker']
            stage = 'docker_access_sudo'
            run(stage, d+['info','--format','{{.ServerVersion}}'], context)
        stage = 'container_presence'
        running = checked_text(run(stage, d+['inspect','--type','container','--format','{{.State.Running}}',CONTAINER], context), stage, context)
        context['containerExists'] = True
        if running != 'true':
            raise SafeFailure(stage, d[0], 0, 'container_not_running', context)
        stage = 'compose_project'
        project = checked_text(run(stage, d+['inspect','--format','{{index .Config.Labels "com.docker.compose.project"}}',CONTAINER], context), stage, context)
        if project != 'movabi-develop':
            raise SafeFailure(stage, d[0], 0, 'compose_project_mismatch', context)
        stage = 'image_before'
        image = checked_text(run(stage, d+['inspect','--format','{{.Image}}',CONTAINER], context), stage, context)
        if not re.fullmatch(r'sha256:[a-f0-9]{64}', image):
            raise SafeFailure(stage, d[0], 0, 'image_identity_invalid', context)
        stage = 'source_path_probe'
        probe = decode_json(run(stage, d+['exec',CONTAINER,'node','-e',source_probe_code()], context), stage, context)
        if (not isinstance(probe, dict) or set(probe)!=set(PATHS)
                or any(not isinstance(x,dict) or set(x)!={'exists','safe'} or x['exists'] not in (True,False,None) or type(x['safe']) is not bool for x in probe.values())):
            raise SafeFailure(stage, d[0], 0, 'source_metadata_invalid', context)
        context['sourcePathExists'] = {name:probe[name]['exists'] for name in PATHS}
        if any(x['exists'] is False and name not in OPTIONAL_ABSENT for name,x in probe.items()):
            raise SafeFailure(stage, d[0], 0, 'source_path_missing', context)
        if any(not x['safe'] and not (name in OPTIONAL_ABSENT and x['exists'] is False) for name,x in probe.items()):
            raise SafeFailure(stage, d[0], 0, 'source_path_unsafe_or_unreadable', context)
        stage = 'source_export'
        encoded = decode_json(run(stage, d+['exec',CONTAINER,'node','-e',source_export_code()], context,
                                  {20:'source_path_disappeared',21:'source_path_safety_changed',22:'source_read_permission_denied',23:'source_read_failed'}), stage, context)
        if not isinstance(encoded,dict) or set(encoded)!=set(PATHS):
            raise SafeFailure(stage, d[0], 0, 'source_allowlist_mismatch', context)
        try:
            data = {}
            for name in PATHS:
                entry=encoded[name]
                if not isinstance(entry,dict) or type(entry.get('exists')) is not bool:raise ValueError()
                if entry['exists']:
                    if set(entry)!={'exists','content'}:raise ValueError()
                    data[name]=base64.b64decode(entry['content'],validate=True)
                    if len(data[name])>MAX_SOURCE:raise ValueError()
                elif name not in OPTIONAL_ABSENT or set(entry)!={'exists'}:raise ValueError()
                # The export must agree with its preceding existence probe.
                if entry['exists'] is not probe[name]['exists']:
                    raise SafeFailure(stage,d[0],0,'source_presence_changed_during_export',context)
        except (ValueError,TypeError):
            raise SafeFailure(stage,d[0],0,'source_encoding_or_size_invalid',context) from None
        stage = 'image_after'
        after = checked_text(run(stage, d+['inspect','--format','{{.Image}}',CONTAINER], context), stage, context)
        if after != image:
            raise SafeFailure(stage, d[0], 0, 'image_changed_during_export', context)
        stage = 'wallet_filename_inventory'
        found, denied = inventory()
        stage = 'existing_export_evidence'
        prior = previous_evidence()
        stage = 'archive_write'
        folder, result = write_export(data, image, prior)
        result.update(walletFilenameInventory=found, unreadableDirectories=denied,
                      bindingContentsRead=False, bindingChecks='unknown_until_wallet_file_verified',
                      servicesChanged=False, databaseAccessed=False, providerRequestsMade=False,
                      recoveredCommandDiagnostics=diagnostics)
        stage = 'completion_marker'
        marker = folder/'completion.json'
        with marker.open('x', encoding='utf-8') as stream:
            os.chmod(marker,0o600)
            json.dump(result,stream,sort_keys=True)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        print(json.dumps(result, sort_keys=True))
        return 0
    except SafeFailure as failure:
        diagnostics.append(failure.diagnostic)
    except Exception as error:
        reason = 'filesystem_permission_denied' if isinstance(error,PermissionError) else 'filesystem_or_internal_failure_output_withheld'
        diagnostics.append(SafeFailure(stage,'python3',None,reason,context).diagnostic)
    print(json.dumps({'completed':False,'diagnostics':diagnostics,'noSecretValuesPrinted':True},sort_keys=True))
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
