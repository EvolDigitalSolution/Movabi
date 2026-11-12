#!/usr/bin/env node
// Classify every rehearsal-chain migration against develop's live schema, from the snapshots written by
// reconcile-live-schema.sh. For each object a migration creates or changes (function body, table
// columns, trigger definition), compare develop's live fingerprint with the version that migration
// produced:
//   applied     live = this migration's version, or a later chain version of the same object
//   pending     live = an earlier version, or the object is absent
//   drift       live = a body no chain step produced (manual or out-of-chain change) -> review
// Usage: node scripts/release/classify-live.cjs <reconcile-out-dir>
'use strict';
const fs=require('fs'),path=require('path');
const dir=process.argv[2];
const read=f=>{const m=new Map();for(const line of fs.readFileSync(path.join(dir,f),'utf8').split('\n')){if(!line.trim())continue;const i=line.lastIndexOf('\t');m.set(line.slice(0,i),line.slice(i+1).trim());}return m;};
const kinds=['functions','tables','triggers'];
const snaps=fs.readdirSync(dir).filter(f=>/^snap-\d{3}-.*-functions\.tsv$/.test(f)).sort().map(f=>f.replace(/-functions\.tsv$/,''));
const data=snaps.map(s=>({name:s.replace(/^snap-\d{3}-/,''),...Object.fromEntries(kinds.map(k=>[k,read(`${s}-${k}.tsv`)]))}));
const live=Object.fromEntries(kinds.map(k=>[k,read(`live-${k}.tsv`)]));
const report=[];const summary=[];
for(let i=1;i<data.length;i++){
  const prev=data[i-1],cur=data[i];const items=[];
  for(const k of kinds){
    for(const [obj,md5] of cur[k]){
      if(prev[k].get(obj)===md5)continue;           // unchanged by this migration
      const later=new Set();for(let j=i+1;j<data.length;j++){const v=data[j][k].get(obj);if(v)later.add(v);}
      const earlier=new Set();for(let j=0;j<i;j++){const v=data[j][k].get(obj);if(v)earlier.add(v);}
      const l=live[k].get(obj);
      const state=l===md5||(later.has(l)&&!earlier.has(l))?'applied':!l||earlier.has(l)?'pending':'drift';
      items.push({kind:k,obj,state});
    }
    for(const [obj] of prev[k])if(!cur[k].has(obj))items.push({kind:k,obj,state:live[k].has(obj)?'pending(drop)':'applied'});
  }
  const count=s=>items.filter(x=>x.state.startsWith(s)).length;
  const verdict=!items.length?'no-schema-objects':count('drift')?'DRIFT':count('pending')&&count('applied')?'PARTIAL':count('pending')?'PENDING':'APPLIED';
  summary.push(`${String(i).padStart(3,'0')} ${verdict.padEnd(17)} ${cur.name}  (applied ${count('applied')}, pending ${count('pending')}, drift ${count('drift')})`);
  for(const x of items)if(x.state!=='applied')report.push(`${cur.name}\t${x.kind}\t${x.state}\t${x.obj}`);
}
// Objects live has that the final chain state does not produce identically.
const last=data[data.length-1];const extra=[];
for(const k of kinds)for(const [obj,md5] of live[k]){const f=last[k].get(obj);if(f===undefined)extra.push(`live-only\t${k}\t${obj}`);else if(f!==md5){/* will be replaced by the release */}}
const replaced=[];for(const k of kinds)for(const [obj,md5] of last[k]){const l=live[k].get(obj);if(l!==md5)replaced.push(`${l===undefined?'create':'replace'}\t${k}\t${obj}`);}
fs.writeFileSync(path.join(dir,'classification.txt'),summary.join('\n')+'\n');
fs.writeFileSync(path.join(dir,'classification-details.tsv'),report.join('\n')+'\n');
fs.writeFileSync(path.join(dir,'live-only.tsv'),extra.join('\n')+'\n');
fs.writeFileSync(path.join(dir,'release-changes.tsv'),replaced.join('\n')+'\n');
console.log(summary.join('\n'));
console.log(`\nlive objects outside the chain's final state: ${extra.length}   objects the release would create/replace: ${replaced.length}`);
