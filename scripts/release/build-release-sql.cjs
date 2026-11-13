#!/usr/bin/env node
// Build the develop release migration as ONE transaction, plus its rollback and a dry run.
// The 7 migrations pending on develop (reconciled 2026-11-12 against the live schema) are concatenated
// byte-for-byte in develop order. Each file's own outer BEGIN;/COMMIT; is removed. The edit is
// asserted: exactly one pair as the first/last statement, or none. Any other transaction control
// (or non-transactional DDL) aborts the build.
// Outputs (deploy/vaydu-develop-release/):
//   release-up.sql       BEGIN; <7 migrations> COMMIT;
//   release-dryrun.sql   BEGIN; <7 migrations> ROLLBACK;   (real data, changes nothing)
//   release-down.sql     BEGIN; <7 rollbacks, reverse order> COMMIT;
//   RELEASE-MIGRATIONS.sha256
'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const root=path.resolve(__dirname,'../..');
// A later release passes VAYDU_RELEASE_CONFIG=<json>: {out, up[], down[], restore[], title}. Without it,
// release 1 (below) is rebuilt byte-identically.
const CFG=process.env.VAYDU_RELEASE_CONFIG?JSON.parse(fs.readFileSync(path.resolve(process.env.VAYDU_RELEASE_CONFIG),'utf8')):null;
const out=process.env.VAYDU_RELEASE_OUT?path.resolve(process.env.VAYDU_RELEASE_OUT):path.join(root,CFG?CFG.out:'deploy/vaydu-develop-release');
const UP=CFG?CFG.up:[
 'supabase/migrations/20261266000000_driver_cash_credit_market_pilot.sql',
 'supabase/migrations/20261266100000_cash_ride_booking_fee_hold.sql',
 'supabase/migrations/20261266200000_cash_ride_activation.sql',
 'supabase/migrations/20261266300000_cash_ride_completion.sql',
 'supabase/migrations/20261267000000_driver_cancellation_attribution.sql',
 'supabase/migrations/20261268000000_cancellation_fee_quote.sql',
 'supabase/migrations/20261269000000_merge_cash_pilot_with_roadmap_cash.sql',
];
const DOWN=CFG?CFG.down:[
 'scripts/migration-merge/20261269000000_merge_cash_pilot_with_roadmap_cash.down.sql',
 'scripts/cancellation-fee/20261268000000_cancellation_fee_quote.down.sql',
 'scripts/driver-metrics/20261267000000_driver_cancellation_attribution.down.sql',
 'deploy/vaydu-cash-ride-market-pilot/20261266300000_cash_ride_completion.down.sql',
 'deploy/vaydu-cash-ride-market-pilot/20261266200000_cash_ride_activation.down.sql',
 'deploy/vaydu-cash-ride-market-pilot/20261266100000_cash_ride_booking_fee_hold.down.sql',
 'deploy/vaydu-cash-ride-market-pilot/20261266000000_driver_cash_credit_market_pilot.down.sql',
];
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const CONTROL=/^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\s*;\s*$/i; // a bare "END;" closes PL/pgSQL bodies
const FORBIDDEN=/\b(CONCURRENTLY|VACUUM)\b|ALTER\s+TYPE\s+\S+\s+ADD\s+VALUE|^\s*\\/im;
function body(rel){
  const buf=fs.readFileSync(path.join(root,rel));const text=buf.toString('utf8');
  const lines=text.split('\n');const idx=lines.map((l,i)=>CONTROL.test(l.replace(/\r$/,''))?i:-1).filter(i=>i>=0);
  if(FORBIDDEN.test(text))throw new Error(`${rel}: contains a statement that cannot run inside one transaction`);
  const significant=lines.map((l,i)=>({l:l.replace(/\r$/,''),i})).filter(x=>x.l.trim()&&!/^\s*--/.test(x.l));
  if(idx.length===0)return {rel,sha:sha(buf),text,stripped:0};
  if(idx.length!==2)throw new Error(`${rel}: expected 0 or 2 transaction-control lines, found ${idx.length}`);
  const [b,c]=idx;
  if(!/^\s*BEGIN\s*;/i.test(lines[b])||!/^\s*COMMIT\s*;/i.test(lines[c]))throw new Error(`${rel}: control lines are not BEGIN ... COMMIT`);
  if(significant[0].i!==b||significant[significant.length-1].i!==c)throw new Error(`${rel}: BEGIN/COMMIT are not the outermost statements`);
  const kept=lines.filter((_,i)=>i!==b&&i!==c).join('\n');
  return {rel,sha:sha(buf),text:kept,stripped:2};
}
// Develop's exact current definitions of every function the release REPLACES (reconciled 2026-11-12,
// release-changes.tsv). The older rollback files restore pre-roadmap bodies, so release-down.sql ends
// by restoring these from the committed live baseline (CR bytes inside bodies kept as they are).
const LIVE_BASELINE='supabase/baseline/develop_live_public_schema_20261112.sql';
const RESTORE=CFG?(CFG.restore||[]):[
 'public.driver_cash_credit_status_v1f(p_driver_id uuid)',
 'public.enforce_job_payment_eligibility()',
 'public.enforce_ride_cash_credit_v1e()',
 'public.reserve_cash_job_credit_v1e(p_job_id uuid, p_driver_id uuid)',
];
function liveDefinition(dump,signature){
  const head='\nCREATE FUNCTION '+signature+' ';
  const at=dump.indexOf(head);
  if(at<0||dump.indexOf(head,at+1)>=0)throw new Error(`live baseline: ${signature} not found exactly once`);
  const start=at+1;
  const as=/\n\s*AS (\$[A-Za-z_]*\$)/g;as.lastIndex=start;const m=as.exec(dump);
  if(!m)throw new Error(`live baseline: no body for ${signature}`);
  // A dollar-quoted body cannot contain its own tag, so the first "<tag>;" after the opener ends it
  // (pg_dump may put it on the body's last line, e.g. "END $_$;").
  const close=m[1]+';';const end=dump.indexOf(close,m.index+m[0].length);
  if(end<0)throw new Error(`live baseline: unterminated body for ${signature}`);
  if(dump.slice(m.index+m[0].length,end).includes('\nCREATE FUNCTION '))throw new Error(`live baseline: body of ${signature} overran into another function`);
  return 'CREATE OR REPLACE FUNCTION'+dump.slice(start+'CREATE FUNCTION'.length,end+close.length);
}
function restoreSection(){
  if(!RESTORE.length)return '';
  const raw=fs.readFileSync(path.join(root,LIVE_BASELINE));const dump=raw.toString('utf8');
  let s=`\n-- ===== Restore develop's exact pre-release definitions (${LIVE_BASELINE}, sha256 ${sha(raw)}) =====\n`;
  for(const sig of RESTORE)s+=`-- ${sig}\n${liveDefinition(dump,sig)}\n`;
  return s;
}
function build(list,end,title,extra=''){
  const parts=list.map(body);
  let s=`-- ${title}\n-- Generated by scripts/release/build-release-sql.cjs. Do not edit; regenerate.\n-- One transaction: any error rolls back every step (psql -v ON_ERROR_STOP=1).\n`;
  for(const p of parts)s+=`-- source ${p.rel} sha256 ${p.sha} (outer BEGIN/COMMIT removed: ${p.stripped===2?'yes':'none present'})\n`;
  s+=`\\set ON_ERROR_STOP on\nBEGIN;\nSET LOCAL lock_timeout = '10s';\nSET LOCAL statement_timeout = '5min';\n`;
  for(const p of parts)s+=`\n-- ===== BEGIN ${path.basename(p.rel)} =====\n${p.text}\n-- ===== END ${path.basename(p.rel)} =====\n`;
  // PostgREST caches the schema: without this, RPCs the release creates are "not in the schema cache"
  // until it reloads (found on develop 2026-11-13). NOTIFY is transactional: delivered only on COMMIT,
  // so the dry run (ROLLBACK) and a failed release never trigger a reload.
  s+=`${extra}\n-- Tell PostgREST to reload its schema cache (delivered at COMMIT only).\nNOTIFY pgrst, 'reload schema';\n${end}\n`;return {s,parts};
}
fs.mkdirSync(out,{recursive:true});
const T=CFG?CFG.title:'Vaydu develop release: 7 pending migrations (cash chain, D9 attribution, fee quote, merge)';
const up=build(UP,'COMMIT;',T);
const dry=build(UP,'ROLLBACK;','DRY RUN of release-up.sql against real data: ends in ROLLBACK, changes nothing');
const down=build(DOWN,'COMMIT;',CFG?`${T}: ROLLBACK, newest first`:"Vaydu develop release ROLLBACK: the 7 rollbacks, newest first, then develop's exact pre-release function definitions",restoreSection());
fs.writeFileSync(path.join(out,'release-up.sql'),up.s);
fs.writeFileSync(path.join(out,'release-dryrun.sql'),dry.s);
fs.writeFileSync(path.join(out,'release-down.sql'),down.s);
const sums=['release-up.sql','release-dryrun.sql','release-down.sql'].map(f=>`${sha(fs.readFileSync(path.join(out,f)))}  ${f}`).join('\n')+'\n';
fs.writeFileSync(path.join(out,'RELEASE-MIGRATIONS.sha256'),sums);
process.stdout.write(sums);
for(const p of [...up.parts,...down.parts])console.log(`${p.stripped===2?'stripped BEGIN/COMMIT':'no outer txn       '}  ${p.rel}`);
