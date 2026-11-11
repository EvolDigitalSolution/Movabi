// DriverTopupDb backed by the real PostgreSQL schema (develop export + wallet migrations).
// Every statement runs in its own connection as `service_role` (the role the API's
// Supabase service key uses), so grants, RLS bypass, triggers, CHECKs, unique
// constraints, row locks and the SQL functions themselves are all exercised.
const {execFile}=require('node:child_process');
const PSQL=['-h','/var/tmp','-p','55432','-U','postgres','-X','-q','-At','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-d','vaydu_batch2a_test'];
function psql(sql,vars={},role='service_role'){
  const args=[...PSQL];for(const [k,v] of Object.entries(vars))args.push('-v',`${k}=${v}`);
  const script=(role?`SET ROLE ${role};\n`:'')+sql;
  return new Promise((resolve)=>{const c=execFile('psql',[...args,'-f','-'],{maxBuffer:1<<24},(err,stdout,stderr)=>resolve({err,stdout:stdout.trim(),stderr}));c.stdin.end(script);});
}
function lit(v){ // bind via psql variables, referenced as :'pN' (server-side quoted literal)
  if(v===null||v===undefined)return null;if(typeof v==='object')return JSON.stringify(v);return String(v);
}
function sqlstate(stderr){const m=/ERROR:\s+([0-9A-Z]{5}):/.exec(stderr||'');return m?m[1]:null;}
let fnTypes=null;
async function types(){if(fnTypes)return fnTypes;const r=await psql(`select coalesce(json_object_agg(proname,pg_get_function_result(oid)),'{}') from pg_proc where pronamespace='public'::regnamespace`,{},null);fnTypes=JSON.parse(r.stdout);return fnTypes;}
function qb(table){
  const where=[],vars={};let n=0,cols='*',single=false,patch=null,returning=null;
  const bind=v=>{if(v===null)return 'NULL';const k='p'+(++n);vars[k]=lit(v);return `:'${k}'`;};
  const run=async()=>{
    const w=where.length?' WHERE '+where.join(' AND '):'';
    let sql;
    if(patch){const sets=Object.entries(patch).map(([k,v])=>`${k}=${bind(v)}`).join(',');
      sql=`WITH u AS (UPDATE public.${table} SET ${sets}${w} RETURNING ${returning||'*'}) SELECT coalesce(json_agg(to_jsonb(u)),'[]') FROM u;`;}
    else sql=`SELECT coalesce(json_agg(to_jsonb(t)),'[]') FROM (SELECT ${cols} FROM public.${table}${w}) t;`;
    const r=await psql(sql,vars);
    if(r.err)return {data:null,error:{code:sqlstate(r.stderr),message:r.stderr.split('\n')[0]}};
    const rows=JSON.parse(r.stdout.split('\n').pop());
    if(single){if(rows.length>1)return {data:null,error:{code:'PGRST116',message:'multiple rows'}};return {data:rows[0]??null,error:null};}
    return {data:rows,error:null};
  };
  const o={
    select(c){if(patch)returning=c||'*';else cols=c||'*';return o;},
    eq(k,v){where.push(`${k} = ${bind(v)}`);return o;},
    maybeSingle(){single=true;return o;},
    update(p){patch=p;return o;},
    async insert(row){const ks=Object.keys(row);const vs=ks.map(k=>bind(row[k]));
      const r=await psql(`INSERT INTO public.${table} (${ks.join(',')}) VALUES (${vs.join(',')});`,vars);
      return r.err?{error:{code:sqlstate(r.stderr),message:r.stderr.split('\n')[0]}}:{error:null};},
    then(res,rej){return run().then(res,rej);},
  };
  return o;
}
async function rpc(fn,args){
  const t=(await types())[fn];if(!t)throw new Error('no such function '+fn);
  const vars={};let n=0;const named=Object.entries(args||{}).map(([k,v])=>{if(v===null||v===undefined)return `${k} => NULL`;const key='a'+(++n);vars[key]=lit(v);return `${k} => :'${key}'`;});
  const r=await psql(`SELECT (public.${fn}(${named.join(', ')}))::text;`,vars);
  if(r.err){const e=new Error(`RPC ${fn} failed: ${r.stderr.split('\n').find(l=>l.includes('ERROR'))||r.stderr}`);e.sqlstate=sqlstate(r.stderr);throw e;}
  const out=r.stdout.split('\n').pop();
  if(t==='void')return null;if(t==='boolean')return out==='true'||out==='t';if(t==='jsonb'||t==='json')return JSON.parse(out);
  if(/^(integer|bigint|smallint)$/.test(t))return Number(out);return out===''?null:out;
}
module.exports={psql,qb,rpc};
