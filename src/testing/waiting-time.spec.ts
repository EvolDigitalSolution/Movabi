import {describe,it,expect,vi} from 'vitest';
vi.mock('../../server/services/stripe.service',()=>({stripe:{}}));
vi.mock('../../server/services/supabase.service',()=>({supabaseAdmin:{}}));
import {formatWaitingTime} from '../app/shared/utils/waiting-time';
import {NoShowService} from '../../server/services/no-show.service';
describe('readable pickup countdown',()=>{
 it.each([[300,'5 min'],[272,'4 min 32 sec'],[61,'1 min 1 sec'],[60,'1 min'],[59,'59 sec'],[1,'1 sec'],[0,'Waiting period ended'],[-10,'Waiting period ended'],[0.4,'1 sec']] as const)('%s seconds is %s',(n,label)=>{expect(formatWaitingTime(n)).toBe(label);});
 it.each([null,undefined,NaN,Infinity])('unknown clock never claims expiry',n=>{expect(formatWaitingTime(n)).toBe('Checking arrival time...');});
});
describe('maximum five minutes for all policy versions',()=>{
 it.each(['ride-no-show-v1','ride-no-show-v2','ride-no-show-v3'])('%s is capped at five minutes',version=>{expect(NoShowService.graceMinutesFor({noShowPolicyVersion:version})).toBe(5);});
 it('does not change the current no-show fee or compensation',()=>{expect(NoShowService.computeCurrentNoShowSplit(1200)).toMatchObject({feeMinor:380,driverShareMinor:304,platformShareMinor:76});});
});
import fs from 'node:fs';import vm from 'node:vm';import ts from 'typescript';
it('a shortened server deadline replaces the old countdown without restarting arrival',()=>{
 vi.useFakeTimers();
 try {
  const source=fs.readFileSync('src/app/apps/mobile/features/customer/booking-tracking/booking-tracking.page.ts','utf8');
  const ast=ts.createSourceFile('tracking.ts',source,ts.ScriptTarget.Latest,true),klass=ast.statements.find(ts.isClassDeclaration)!;
  const names=['startArrivalCountdown','updateArrivalCountdown','clearArrivalCountdown'];
  const code=klass.members.filter(m=>names.includes(m.name?.getText(ast)||'')).map(m=>m.getText(ast)).join('\n');
  const ctx:any={exports:{},Date,setInterval,clearInterval};
  vm.runInNewContext(ts.transpileModule('export class Clock {'+code+'}',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,ctx);
  const clock=new ctx.exports.Clock();let value:number|null=null;
  const signal:any=()=>value;signal.set=(v:number|null)=>{value=v;};clock.arrivalCountdownSeconds=signal;
  const arrived=Date.now();clock.startArrivalCountdown(new Date(arrived+420000).toISOString());
  clock.startArrivalCountdown(new Date(arrived+300000).toISOString());vi.advanceTimersByTime(1000);
  expect(value).toBe(299);expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(299000);expect(value).toBe(0);expect(vi.getTimerCount()).toBe(0);
 } finally {vi.useRealTimers();}
});
