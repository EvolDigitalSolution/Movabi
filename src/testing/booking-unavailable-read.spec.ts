import {expect,it,vi} from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function reader(response:any){
 const source=fs.readFileSync('src/app/core/services/booking/booking.service.ts','utf8');
 const parsed=ts.createSourceFile('booking.ts',source,ts.ScriptTarget.Latest,true);
 const klass=parsed.statements.find(ts.isClassDeclaration)!;
 const method=klass.members.find(m=>m.name?.getText(parsed)==='getBooking')!.getText(parsed);
 const context:any={exports:{}};vm.runInNewContext(ts.transpileModule('export class Reader {'+method+'}',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
 const r=new context.exports.Reader();const maybeSingle=vi.fn(async()=>response);const q={select(){return this;},eq(){return this;},maybeSingle};r.supabase={from:()=>q};return {r,maybeSingle};
}
it('handles a hidden or removed booking without requiring one returned row',async()=>{const {r,maybeSingle}=reader({data:null,error:null});await expect(r.getBooking('job')).rejects.toThrow('unavailable or not accessible');expect(maybeSingle).toHaveBeenCalledTimes(1);});
it('does not hide genuine database failures',async()=>{const failure={code:'42501',message:'denied'};const {r}=reader({data:null,error:failure});await expect(r.getBooking('job')).rejects.toEqual(failure);});
