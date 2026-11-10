import {parseDriverCashCredit,type DriverCashCreditStatus} from '../../../shared/utils/driver-cash-credit';
export interface DriverCashCreditViewState {owner:string|null;value:DriverCashCreditStatus|null;loading:boolean;error:string;}
/** In-memory, owner-isolated read state; never used as an acquisition or spending authority. */
export class DriverCashCreditReader {
 private owner:string|null=null; private generation=0; private until=0;
 private value:DriverCashCreditStatus|null=null; private pending:Promise<DriverCashCreditStatus>|null=null;
 private readonly currentOwner:()=>string|null;
 private readonly fetchStatus:(owner:string)=>Promise<unknown>;
 private readonly publish:(state:DriverCashCreditViewState)=>void;
 private readonly now:()=>number;
 constructor(currentOwner:()=>string|null,fetchStatus:(owner:string)=>Promise<unknown>,publish:(state:DriverCashCreditViewState)=>void,now:()=>number=Date.now){
  this.currentOwner=currentOwner;this.fetchStatus=fetchStatus;this.publish=publish;this.now=now;
 }
 reset(owner:string|null):void {
  if(this.owner===owner)return;
  this.owner=owner;this.generation++;this.until=0;this.value=null;this.pending=null;
  this.publish({owner,value:null,loading:false,error:''});
 }
 refresh(force=false):Promise<DriverCashCreditStatus> {
  const owner=this.currentOwner();this.reset(owner);
  if(!owner){this.publish({owner:null,value:null,loading:false,error:'Sign in to view cash credit.'});return Promise.reject(Error('Sign in required.'));}
  if(this.pending)return this.pending;
  if(!force&&this.value&&this.until>this.now())return Promise.resolve(this.value);
  const generation=this.generation;
  const current=()=>this.generation===generation&&this.owner===owner&&this.currentOwner()===owner;
  this.value=null;this.until=0;this.publish({owner,value:null,loading:true,error:''});
  const request:Promise<DriverCashCreditStatus>=Promise.resolve().then(()=>{if(!current())throw Error('Account changed.');return this.fetchStatus(owner);})
   .then(raw=>{if(!current())throw Error('Account changed.');const value=parseDriverCashCredit(raw,owner);
    this.value=value;this.until=this.now()+15000;this.publish({owner,value,loading:false,error:''});return value;})
   .catch((error:unknown)=>{if(current()){this.value=null;this.until=0;this.publish({owner,value:null,loading:false,error:'Cash credit could not be verified. Please retry.'});}throw error;})
   .finally(()=>{if(this.pending===request)this.pending=null;});
  this.pending=request;return request;
 }
}
