"""Operator-run develop API staging/rollback. Never reads secrets or deploys on import.

No activation command is provided: merchant identity and split approval are unresolved.
Uses original Compose references to preserve the existing DB connection in place.
"""
import argparse
import json
import os
from pathlib import Path
import re
import stat
import subprocess

PRIVATE=Path('/home/edsadmin/.config/vaydu-collection-subaccount-sandbox/flutterwave-test.env')
REVIEW=Path.home()/'ng-cohost-release'
FLAGS={'VAYDU_DEPLOYMENT_ENV':'develop','VAYDU_DRIVER_SUBACCOUNT_COHOST_DEVELOP':'true',
       'VAYDU_DRIVER_SUBACCOUNT_SANDBOX':'false','VAYDU_DRIVER_SUBACCOUNT_MERCHANT_VERIFIED':'false',
       'VAYDU_DRIVER_SUBACCOUNT_DEFAULT_APPROVED':'false','VAYDU_DRIVER_PAYOUT_SANDBOX':'false',
       'VAYDU_DRIVER_TOPUP_API':'false','VAYDU_FLUTTERWAVE_BOOKING_SPLIT_SANDBOX':'false',
       'VAYDU_BOOKING_SPLIT_TIMING_APPROVED':'false','FLUTTERWAVE_LIVE_SECRET_KEY':''}

def run(args):
    result=subprocess.run(args,capture_output=True,text=True,timeout=180)
    if result.returncode:raise RuntimeError('Operator command failed; raw output withheld. Inspect privately without printing environment/configuration.')
    return result.stdout.strip()

def metadata(docker,name,template):
    return run(docker+['inspect','--format',template,name])

def identity(docker):
    api='movabi-develop-api'
    label=lambda key:metadata(docker,api,'{{index .Config.Labels "'+key+'"}}')
    if label('com.docker.compose.project')!='movabi-develop':raise RuntimeError('Verified develop project required')
    service=label('com.docker.compose.service')
    files=label('com.docker.compose.project.config_files').split(',')
    directory=label('com.docker.compose.project.working_dir')
    if not re.fullmatch(r'[A-Za-z0-9_-]+',service):raise RuntimeError('Compose service identity unavailable')
    if not files or any(not Path(f).is_absolute() or not Path(f).is_file() for f in files):raise RuntimeError('Original compose references unavailable; use supported release launcher')
    if not Path(directory).is_absolute() or not Path(directory).is_dir():raise RuntimeError('Original compose working directory unavailable')
    if metadata(docker,'movabi-develop-db','{{.Image}}')!='sha256:632d750850d22dbc57c28380bed582538bd1a0b4c963fac50e2fa03e6c26542c':raise RuntimeError('Develop DB image changed; audit required')
    networks=json.loads(metadata(docker,'movabi-develop-db','{{json .NetworkSettings.Networks}}'))
    if set(networks)!={'movabi-develop-private'}:raise RuntimeError('Develop DB network changed; audit required')
    return {'service':service,'files':files,'directory':directory,'previousImage':metadata(docker,api,'{{.Image}}')}

def compose(docker,record,override):
    command=docker+['compose','--project-name','movabi-develop','--project-directory',record['directory']]
    for filename in record['files']:command+=['-f',filename]
    return command+['-f',str(override),'up','-d','--no-deps','--no-build','--pull','never','--force-recreate',record['service']]

def write_private(path,value):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as output:json.dump(value,output,indent=2);output.write('\n')

def main():
    parser=argparse.ArgumentParser()
    action=parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--plan',action='store_true')
    action.add_argument('--stage-disabled',action='store_true')
    action.add_argument('--rollback',action='store_true')
    parser.add_argument('--image')
    parser.add_argument('--setup-only-directory')
    parser.add_argument('--rehearsal-manifest')
    parser.add_argument('--allow-missing-schema-disabled',action='store_true',help='Explicit application-only disabled stage; no SQL deployment or onboarding readiness')
    args=parser.parse_args()
    if args.setup_only_directory and args.allow_missing_schema_disabled:raise RuntimeError('Setup-only staging requires its schema; missing-schema exception forbidden')
    if args.allow_missing_schema_disabled and not args.stage_disabled:raise RuntimeError('Missing-schema exception is limited to disabled staging')
    docker=['docker']
    try:run(docker+['info','--format','{{.ServerVersion}}'])
    except RuntimeError:docker=['sudo','-n','docker']
    current=identity(docker)
    if args.rollback:
        if REVIEW.is_symlink() or REVIEW.stat().st_uid!=os.getuid() or stat.S_IMODE(REVIEW.stat().st_mode)!=0o700:raise RuntimeError('Private operator-owned review directory required for rollback')
        record_path=REVIEW/'release.json'
        if record_path.is_symlink():raise RuntimeError('Unsafe release record')
        record=json.loads(record_path.read_text())
        if any(current[k]!=record[k] for k in ['service','directory']):raise RuntimeError('Release identity changed')
        # Current labels also contain our staging override; use retained original references.
        if not re.fullmatch(r'sha256:[a-f0-9]{64}',record['previousImage']):raise RuntimeError('Invalid rollback image')
        run(docker+['image','inspect','--format','{{.Id}}',record['previousImage']])
        rollback=REVIEW/'rollback.json'
        write_private(rollback,{'services':{record['service']:{'image':record['previousImage'],'environment':{**FLAGS,'VAYDU_DRIVER_SUBACCOUNT_COHOST_DEVELOP':'false'}}}})
        run(compose(docker,record,rollback))
        print(json.dumps({'rollbackRequested':True,'serviceOnly':record['service'],'databaseCredentialsRead':False,'activationEnabled':False}))
        return
    if not args.image or not re.fullmatch(r'sha256:[a-f0-9]{64}',args.image):raise RuntimeError('Supply the reviewed immutable local API image ID, not an unverified tag')
    if run(docker+['image','inspect','--format','{{.Id}}',args.image])!=args.image:raise RuntimeError('Reviewed image unavailable')
    if PRIVATE.is_symlink():raise RuntimeError('Private provider source cannot be a symlink')
    info=PRIVATE.stat()
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode)!=0o600 or info.st_size>16384:raise RuntimeError('Expected existing private 0600 provider file; do not reprovision')
    sql="SELECT to_regclass('public.driver_collection_markets') IS NOT NULL AND to_regclass('public.driver_collection_subaccounts') IS NOT NULL AND to_regprocedure('public.claim_driver_collection_subaccount(uuid,uuid,text,text,text,text,text)') IS NOT NULL;"
    setup_artifact=None
    setup_proof_sha=None
    if args.setup_only_directory:
        from setup_only_release import load_release,load_real_proof,DISABLED_SQL,ensure_no_legacy_setup
        setup_artifact=load_release(args.setup_only_directory)
        sql="SELECT to_regclass('public.driver_collection_setup_markets') IS NOT NULL AND to_regclass('public.driver_collection_setup_accounts') IS NOT NULL AND to_regprocedure('public.claim_driver_collection_setup(uuid,uuid,text,text,text,text,text)') IS NOT NULL;"
        if args.stage_disabled:
            if not args.rehearsal_manifest:raise RuntimeError('Real setup-only rehearsal manifest required before staging')
            proof,setup_proof_sha=load_real_proof(args.rehearsal_manifest,setup_artifact)
            receipt_path=REVIEW/'setup-only-schema.json'
            if receipt_path.is_symlink():raise RuntimeError('Unsafe setup schema receipt')
            receipt=json.loads(receipt_path.read_text())
            if receipt.get('state')!='applied' or receipt.get('manifestSha256')!=setup_artifact['manifestSha256'] or receipt.get('rehearsalProofSha256')!=setup_proof_sha:raise RuntimeError('Exact setup-only schema receipt required')
    schema_ready=run(docker+['exec','movabi-develop-db','psql','-X','-U','postgres','-d','movabi_develop','-At','-v','ON_ERROR_STOP=1','-c',sql])=='t'
    if setup_artifact and args.stage_disabled and schema_ready:
        ensure_no_legacy_setup(lambda query:run(docker+['exec','movabi-develop-db','psql','-X','-U','postgres','-d','movabi_develop','-At','-v','ON_ERROR_STOP=1','-c',query]))
        if run(docker+['exec','movabi-develop-db','psql','-X','-U','postgres','-d','movabi_develop','-At','-v','ON_ERROR_STOP=1','-c',DISABLED_SQL])!='t':raise RuntimeError('Setup-only schema approvals/defaults/accounts not disabled')
        quiet_sql="SELECT NOT EXISTS(SELECT 1 FROM public.job_payout_queue WHERE status IN('pending','processing','reconcile'));"
        if run(docker+['exec','movabi-develop-db','psql','-X','-U','postgres','-d','movabi_develop','-At','-v','ON_ERROR_STOP=1','-c',quiet_sql])!='t':raise RuntimeError('Existing payout work is active; choose a quiet window without altering the outbox')
    if not schema_ready and not args.plan and not args.allow_missing_schema_disabled:raise RuntimeError('Reviewed collection migrations are not deployed; apply the unchanged reviewed set through the develop migration procedure first')
    user=metadata(docker,'movabi-develop-api','{{.Config.User}}')
    if user not in ('','root','0',str(info.st_uid),str(info.st_uid)+':'+str(info.st_gid)):raise RuntimeError('Verify API runtime UID can read the existing file before staging; do not loosen permissions')
    override={'services':{current['service']:{'image':args.image,'environment':{**FLAGS,'VAYDU_DRIVER_SUBACCOUNT_FILE_OWNER_UID':str(info.st_uid)},
        'volumes':[{'type':'bind','source':str(PRIVATE),'target':'/run/vaydu/flutterwave-test.env','read_only':True,'bind':{'create_host_path':False}}]}}}
    if args.plan:
        print(json.dumps({'planOnly':True,'service':current['service'],'image':args.image,'previousImage':current['previousImage'],'privateFileReference':str(PRIVATE),
            'fileOwnerUid':info.st_uid,'migrationPrerequisitesPresent':schema_ready,'activationEnabled':False,'merchantApproved':False,'defaultSplitApproved':False,'databaseCredentialsRead':False,
            'restartImpact':'Only existing develop API recreated; in-flight API requests/connections may be interrupted; frontend/database not restarted'},sort_keys=True))
        return
    if REVIEW.is_symlink():raise RuntimeError('Unsafe review directory')
    REVIEW.mkdir(mode=0o700,exist_ok=True)
    if REVIEW.stat().st_uid!=os.getuid() or stat.S_IMODE(REVIEW.stat().st_mode)!=0o700:raise RuntimeError('Review directory must be owned by operator with mode 0700')
    current['setupOnlyManifestSha256']=setup_artifact['manifestSha256'] if setup_artifact else None
    current['reviewedImage']=args.image
    current['migrationPrerequisitesPresent']=schema_ready
    current['applicationOnlyDisabledStage']=bool(args.allow_missing_schema_disabled)
    write_private(REVIEW/'release.json',current)
    write_private(REVIEW/'stage.json',override)
    run(compose(docker,current,REVIEW/'stage.json'))
    print(json.dumps({'stagedDisabled':True,'applicationOnlyDisabledStage':bool(args.allow_missing_schema_disabled),'migrationPrerequisitesPresent':schema_ready,'onboardingReady':False,'serviceOnly':current['service'],'merchantApproved':False,'defaultSplitApproved':False,'databaseCredentialsRead':False,'providerRequestsMadeByHelper':False}))

if __name__=='__main__':
    try:main()
    except Exception as error:
        # Never print subprocess payloads, arbitrary exception text or credential data.
        print(json.dumps({'completed':False,'reason':str(error) if isinstance(error,RuntimeError) else 'Private deployment prerequisite failed; inspect privately','deployedApprovalGranted':False}))
        raise SystemExit(1)
