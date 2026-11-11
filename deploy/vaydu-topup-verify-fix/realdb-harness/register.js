// Transpile TS with the repo's own TypeScript semantics (CommonJS) and stub only external clients.
const Module=require('node:module'),path=require('node:path'),fs=require('node:fs');
const ts=require('/home/claude/.npm-global/lib/node_modules/typescript');
const REPO='/home/claude/vaydu';
const orig=Module._resolveFilename;
Module._resolveFilename=function(req,parent,...r){
  if(req==='stripe')return path.join(__dirname,'stripe-stub.js');
  if(/services\/supabase\.service$/.test(req))return path.join(__dirname,'stubs.js');
  return orig.call(this,req,parent,...r);};
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{fileName:f,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
process.env.NODE_PATH=path.join(REPO,'node_modules');Module._initPaths();
