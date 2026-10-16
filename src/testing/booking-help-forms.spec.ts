import {describe,it,expect} from 'vitest';import fs from 'node:fs';import vm from 'node:vm';import ts from 'typescript';import {of,throwError} from 'rxjs';
async function fixture(options:any={}) {
 let dialog:any,finish:any,attempts=0;const posts:any[]=[],ratings:any[]=[],toasts:any[]=[];
 const deps:any={AuthService:{currentUser:()=>({id:'customer'})},HttpClient:{get:()=>of({}),post:(_url:string,body:any)=>{posts.push(body);attempts++;return options.failFirst && attempts===1?throwError(()=>({error:{error:'Network unavailable'}})):of({id:'saved-reference'});}},ApiUrlService:{getApiUrl:(url:string)=>url},SupabaseService:{auth:{getSession:async()=>({data:{session:{access_token:'token'}}})}},AlertController:{create:async(value:any)=>{dialog=value;return {present:async()=>{},onDidDismiss:()=>new Promise(resolve=>finish=resolve)};}},ToastController:{create:async(value:any)=>({present:async()=>toasts.push(value.message)})},BookingService:{rateBooking:async(...args:any[])=>ratings.push(args)}};
 const c:any={exports:{},console,crypto:{randomUUID:()=>`request-${attempts}`},require:(name:string)=>{
 if(name==='@angular/core')return {Injectable:()=>()=>{},inject:(token:string)=>deps[token]};
 if(name==='rxjs')return require('rxjs');
 const key=name.includes('auth.service')?'AuthService':name.includes('http')?'HttpClient':name.includes('api-url')?'ApiUrlService':name.includes('supabase')?'SupabaseService':name.includes('booking.service')?'BookingService':null;
 if(key)return {[key]:key};return {AlertController:'AlertController',ToastController:'ToastController'};
 }};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/core/services/support/booking-help.service.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,experimentalDecorators:true}}).outputText,c);
 const service=new c.exports.BookingHelpService();
 const opened=options.rating?service.rate('job'):service.openSupport('job','help');
 for(let i=0;i<5;i++)await Promise.resolve();
 return {dialog,service,posts,ratings,toasts,async finish(){finish({});await opened;}};
}
describe('in-app help and rating forms',()=>{
 it('keeps the support form open after a failure and retries with the same reference',async()=>{const t=await fixture({failFirst:true});const send=t.dialog.buttons[1].handler;expect(await send({message:'Please help'})).toBe(false);expect(await send({message:'Please help'})).toBe(true);expect(t.posts).toHaveLength(2);expect(t.posts[0].requestId).toBe(t.posts[1].requestId);await t.finish();});
 it('prevents duplicate submissions while a request is in flight',async()=>{const t=await fixture();const send=t.dialog.buttons[1].handler;const first=send({message:'Please help'});expect(await send({message:'Please help'})).toBe(false);await first;expect(t.posts).toHaveLength(1);await t.finish();});
 it('does not send empty or overly long support text',async()=>{const t=await fixture();expect(await t.dialog.buttons[1].handler({message:' '})).toBe(false);expect(await t.dialog.buttons[1].handler({message:'x'.repeat(2001)})).toBe(false);expect(t.posts).toHaveLength(0);await t.finish();});
 it('does not treat an omitted rating as five stars',async()=>{const t=await fixture({rating:true});expect(await t.dialog.buttons[1].handler({score:'',comment:'Review'})).toBe(false);expect(t.ratings).toHaveLength(0);await t.finish();});
 it('saves valid ratings through the in-app booking service',async()=>{const t=await fixture({rating:true});expect(await t.dialog.buttons[1].handler({score:4,comment:'Good service'})).toBe(true);expect(t.ratings).toEqual([['job',4,'Good service']]);await t.finish();});
});
