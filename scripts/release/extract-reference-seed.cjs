#!/usr/bin/env node
// Reference rows that already-applied migrations seeded on develop (fee policy versions, commercial
// policy rows, ...). A schema-only snapshot has none of them, so the route rehearsal on the live schema
// seeds them from the same migrations: only TOP-LEVEL INSERT statements (outside any dollar-quoted
// body), in chain order, each guarded so a duplicate is skipped. This approximates develop's
// configuration; the host dry run against real data covers the real rows.
// Usage: node scripts/release/extract-reference-seed.cjs <chain-list> <out.sql>
'use strict';
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'../..');
const [chainFile,outFile]=process.argv.slice(2);
const list=fs.readFileSync(chainFile,'utf8').split(/\r?\n/).map(s=>s.trim()).filter(s=>s&&!s.startsWith('#'));
function statements(sql){
  const out=[];let cur='',i=0,dollar=null,quote=false,line=false,block=0;
  while(i<sql.length){
    const c=sql[i],rest=sql.slice(i);
    if(line){cur+=c;if(c==='\n')line=false;i++;continue;}
    if(block){cur+=c;if(rest.startsWith('*/')){cur+='/';i+=2;block--;continue;}i++;continue;}
    if(dollar){if(rest.startsWith(dollar)){cur+=dollar;i+=dollar.length;dollar=null;continue;}cur+=c;i++;continue;}
    if(quote){cur+=c;if(c==="'"){if(sql[i+1]==="'"){cur+="'";i+=2;continue;}quote=false;}i++;continue;}
    if(rest.startsWith('--')){line=true;cur+=c;i++;continue;}
    if(rest.startsWith('/*')){block++;cur+='/*';i+=2;continue;}
    const m=rest.match(/^\$[A-Za-z_]*\$/);if(m){dollar=m[0];cur+=m[0];i+=m[0].length;continue;}
    if(c==="'"){quote=true;cur+=c;i++;continue;}
    if(c===';'){out.push(cur.trim());cur='';i++;continue;}
    cur+=c;i++;
  }
  if(cur.trim())out.push(cur.trim());return out;
}
let seed='-- Reference seed for the live-schema route rehearsal (generated; see header of extract-reference-seed.cjs)\n';
let n=0;
for(const m of list){
  if(m.startsWith('candidate/'))continue;
  const sql=fs.readFileSync(path.join(root,'supabase/migrations',m),'utf8');
  for(const st of statements(sql)){
    const body=st.replace(/^(\s*--[^\n]*\n)+/,'').trim();
    if(!/^insert\s+into\s/i.test(body))continue;
    n++;seed+=`-- from ${m}\nDO $seed$ BEGIN\n  ${body};\nEXCEPTION WHEN unique_violation THEN NULL;\nEND $seed$;\n`;
  }
}
fs.writeFileSync(outFile,seed);
console.log(`${n} top-level INSERT statements -> ${outFile}`);
