import { describe,expect,it } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function alerts(user='customer') {
 const source=fs.readFileSync('src/app/core/services/notification/notification-orchestrator.service.ts','utf8');
 const method=source.slice(source.indexOf('  private async handleFundingChange('),source.indexOf('  private async handleJobMessage('));
 const badgeMethods=source.slice(source.indexOf('  getBudgetBadgeCount('),source.indexOf('  private async recoverFunding('));
 const ctx:any={exports:{},console};vm.runInNewContext(ts.transpileModule('export class Alerts {'+method+badgeMethods+'}',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,ctx);
 const a:any=new ctx.exports.Alerts(),shown:any[]=[];a.currentUserId=user;a.seenEventIds=new Set();let badges=new Map();a.budgetBadges=()=>badges;a.budgetBadges.update=(fn:any)=>badges=fn(badges);a.showNotification=async(e:any)=>shown.push(e);a.supabase={client:{from:()=>({select(){return this;},eq(){return this;},maybeSingle:async()=>({data:{customer_id:'customer',driver_id:'driver'}})})}};
 return {a,shown};
}
const funding=(status:string)=>({over_budget_status:status,metadata:{budget_request_id:'request-1'},requested_over_budget_amount:12,updated_at:'2026-10-14T01:00:00Z'});
describe('shopping budget foreground alerts',()=>{
 it('alerts the customer for a request',async()=>{const t=alerts();await t.a.handleFundingChange(funding('requested'),'job');expect(t.shown[0].type).toBe('extra_budget_requested');});
 it('alerts the driver for approval',async()=>{const t=alerts('driver');await t.a.handleFundingChange(funding('approved'),'job');expect(t.shown[0].type).toBe('extra_budget_approved');});
 it('alerts the driver for rejection',async()=>{const t=alerts('driver');await t.a.handleFundingChange(funding('rejected'),'job');expect(t.shown[0].type).toBe('extra_budget_rejected');});
 it('does not alert the wrong participant',async()=>{const t=alerts('driver');await t.a.handleFundingChange(funding('requested'),'job');expect(t.shown).toHaveLength(0);});
 it('deduplicates repeated funding updates for the same request',async()=>{const t=alerts();await t.a.handleFundingChange(funding('requested'),'job');await t.a.handleFundingChange({...funding('requested'),updated_at:'later'},'job');expect(t.shown).toHaveLength(1);});
 it('alerts again for a different request',async()=>{const t=alerts();await t.a.handleFundingChange(funding('requested'),'job');await t.a.handleFundingChange({...funding('requested'),metadata:{budget_request_id:'request-2'}},'job');expect(t.shown).toHaveLength(2);});
 it('adds a Payment badge for an unread budget request',async()=>{const t=alerts();await t.a.handleFundingChange(funding('requested'),'job');expect(t.a.getBudgetBadgeCount('job')).toBe(1);});
 it('clears the Payment badge when reviewed',async()=>{const t=alerts();await t.a.handleFundingChange(funding('requested'),'job');t.a.markBudgetRead('job');expect(t.a.getBudgetBadgeCount('job')).toBe(0);});
});
