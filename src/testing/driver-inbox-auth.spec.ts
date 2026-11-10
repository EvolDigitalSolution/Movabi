import {describe,it,expect} from 'vitest';
import fs from 'node:fs';import vm from 'node:vm';import ts from 'typescript';
async function request(method:string,path:string,authenticated=true){
 const handlers:any={},calls:any[]=[];const router:any={get:(path:string,handler:any)=>handlers['get '+path]=handler,post:(path:string,handler:any)=>handlers['post '+path]=handler};
 const inbox:any={};for(const key of ['counts','page','read','target'])inbox[key]=async(...args:any[])=>{calls.push([key,...args]);return {success:true};};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('server/routes/communication.routes.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:{},console,require:(name:string)=>name==='express'?{Router:()=>router}:name.includes('driver-inbox.service')?{DriverInboxService:inbox,inboxKind:(v:any)=>v,inboxCursor:()=>null}:name.includes('supabase')?{supabaseAdmin:{auth:{getUser:async()=>({data:{user:authenticated?{id:'driver'}:null}})}}}:{}});
 const res:any={code:200,status(code:number){this.code=code;return this;},setHeader(){},json(body:any){this.body=body;return this;}};
 await handlers[method+' '+path]({headers:{authorization:authenticated?'Bearer token':''},query:{kind:'messages',userId:'victim'},params:{kind:'messages',id:'message'},body:{userId:'victim'}},res);return {res,calls};
}
describe('inbox authenticated routes',()=>{
 it.each([['get','/inbox/counts'],['get','/inbox'],['post','/inbox/:kind/:id/read'],['get','/inbox/:kind/:id/target']])('requires authentication for %s %s',async(method,path)=>{const result=await request(method,path,false);expect(result.res.code).toBe(401);expect(result.calls).toHaveLength(0);});
 it.each([['get','/inbox/counts'],['get','/inbox'],['post','/inbox/:kind/:id/read'],['get','/inbox/:kind/:id/target']])('derives ownership from the session for %s %s',async(method,path)=>{const result=await request(method,path);expect(result.res.code).toBe(200);expect(result.calls[0][1]).toBe('driver');expect(JSON.stringify(result.calls)).not.toContain('victim');});
});
