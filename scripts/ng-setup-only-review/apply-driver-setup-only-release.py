"""REVIEWED OPERATOR ACTION ONLY: applies exactly 550 after real restore proof.

Not executed by preparation/rehearsal. No DB credential extraction or generic migration runner.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
from setup_only_release import NAME,load_release,load_real_proof,PROTECTED_SQL,DISABLED_SQL,DEPENDENCY_SQL,ensure_no_legacy_setup

ROOT=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('release',ROOT/'release-driver-collection-cohost.py')
release=importlib.util.module_from_spec(spec);spec.loader.exec_module(release)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--migration-directory',required=True);parser.add_argument('--rehearsal-manifest',required=True)
    parser.add_argument('--apply',action='store_true');args=parser.parse_args()
    artifact=load_release(args.migration_directory);proof,proof_sha=load_real_proof(args.rehearsal_manifest,artifact)
    d=['docker']
    try:release.run(d+['info','--format','{{.ServerVersion}}'])
    except RuntimeError:d=['sudo','-n','docker']
    release.identity(d)
    if proof.get('sourceImage')!=release.metadata(d,'movabi-develop-db','{{.Image}}'):raise RuntimeError('Rehearsed develop DB identity changed')
    def sql(query):return release.run(d+['exec','-e','PGOPTIONS=-c default_transaction_read_only=on -c timezone=UTC -c search_path=pg_catalog,public','movabi-develop-db','psql','-X','-U','postgres','-d','movabi_develop','-qAt','-v','ON_ERROR_STOP=1','-c',query])
    ensure_no_legacy_setup(sql)
    dependencies=json.loads(sql(DEPENDENCY_SQL))
    if not all(dependencies.values()):raise RuntimeError('Setup-only dependencies/names differ; never blind replay or overwrite existing objects')
    before=json.loads(sql(PROTECTED_SQL))
    for name in ['functions','triggers','columns','constraints','relations','routes']:
        if before[name]!=proof.get('protectedFingerprints',{}).get(name):raise RuntimeError('Protected source schema/routing changed since rehearsal')
    if sql('SELECT public.wallet_collection_enabled()')!='f':raise RuntimeError('Collection gate not disabled')
    if not args.apply:
        print(json.dumps({'planOnly':True,'onlyMigration':NAME,'realRestoreProofAccepted':True,'sourceSchemaAndRoutingMatch':True,'merchantApproved':False,'defaultApproved':False}))
        return
    folder=release.REVIEW
    if folder.is_symlink():raise RuntimeError('Unsafe release directory')
    folder.mkdir(mode=0o700,exist_ok=True)
    import os,stat
    if folder.stat().st_uid!=os.getuid() or stat.S_IMODE(folder.stat().st_mode)!=0o700:raise RuntimeError('Private operator-owned release directory required')
    record={'migration':NAME,'migrationSha256':artifact['migrationSha256'],'manifestSha256':artifact['manifestSha256'],'rehearsalProofSha256':proof_sha,'state':'planned','protectedBefore':before}
    release.write_private(folder/'setup-only-schema.pending.json',record)
    result=subprocess.run(d+['exec','-i','movabi-develop-db','psql','-X','-U','postgres','-d','movabi_develop','-v','ON_ERROR_STOP=1'],input=artifact['body'],capture_output=True,timeout=120)
    if result.returncode:raise RuntimeError('Setup-only SQL did not complete; raw diagnostics withheld. Retain pending receipt and inspect state before retrying')
    after=json.loads(sql(PROTECTED_SQL))
    if before!=after or sql(DISABLED_SQL)!='t':raise RuntimeError('Post-schema invariants failed; do not stage API or blindly retry/restore database')
    record.update(state='applied',protectedAfter=after,allSetupApprovalsFalse=True)
    release.write_private(folder/'setup-only-schema.json',record)
    print(json.dumps({'appliedOnly':NAME,'protectedStateUnchanged':True,'approvalsDisabled':True,'providerRequestsMade':False,'migrationHistoryMode':'private checksum receipt; existing tracker unchanged'}))

if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'completed':False,'reason':str(error) if isinstance(error,RuntimeError) else 'Setup-only operator prerequisite failed; raw diagnostic withheld'}))
        raise SystemExit(1)
