import {isWalletSandboxLoopback} from './wallet-sandbox-platform';
export interface WalletSandboxClientDeps{
 owner():string|null;origin():string;native():boolean;request(path:string,method:string,body:unknown,owner:string):Promise<any>;
 load(key:string):string|null;save(key:string,value:string):void;remove(key:string):void;
 id():string;returnReference():string|null;clearReturnReference():void;redirect(url:string):void|Promise<void>;changed(state:any):void;
}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const integer=(v:unknown)=>typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
function validServerReturnOrigin(value:unknown):boolean{try{if(typeof value!=='string')return false;const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&u.origin===value;}catch{return false;}}
export function sandboxReferenceAttempt(reference:unknown):string|null{
 const match=typeof reference==='string'?/^vaydu_test_([a-f0-9]{32})$/.exec(reference):null;
 if(!match)return null;const v=match[1];return `${v.slice(0,8)}-${v.slice(8,12)}-${v.slice(12,16)}-${v.slice(16,20)}-${v.slice(20)}`;
}
export function sandboxMoney(minor:string,currency:string,exponent:number):string{
 if(!integer(minor)||!/^[A-Z]{3}$/.test(currency)||!Number.isInteger(exponent)||exponent<0||exponent>3)return 'Amount unavailable';
 const padded=minor.padStart(exponent+1,'0'),whole=exponent?padded.slice(0,-exponent):padded;
 return currency+' '+whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')+(exponent?'.'+padded.slice(-exponent):'');
}
export class WalletSandboxClient{
 private deps:WalletSandboxClientDeps;private owner:string|null=null;private epoch=0;private dead=false;
 private admission:any=null;private attemptId:string|null=null;
 state:any={visible:false,busy:false,amount:'',message:'',status:'',canStart:false};
 constructor(deps:WalletSandboxClientDeps){this.deps=deps;}
 resetOwner(){const owner=this.dead?null:this.deps.owner();if(owner!==this.owner){this.owner=owner;this.epoch++;this.admission=null;this.attemptId=null;this.state={visible:false,busy:false,amount:'',message:'',status:'',canStart:false};this.emit();return true;}return false;}
 dispose(){this.dead=true;this.resetOwner();}
 private emit(){this.deps.changed({...this.state});}
 private current(owner:string,epoch:number){this.resetOwner();return this.owner===owner&&this.epoch===epoch;}
 private key(owner:string){return 'vaydu-wallet-sandbox-ui:'+owner;}
 private record(owner:string){const s=this.deps.load(this.key(owner));if(!s)return null;const r=JSON.parse(s);if(r.owner!==owner||!uuid(r.key)||r.attemptId!=null&&!uuid(r.attemptId))throw Error('Invalid saved sandbox context');return r;}
 private result(r:any,id?:string){if(!r||!uuid(r.attemptId)||id&&r.attemptId!==id||r.testOnly!==true||r.spendableCredit!==false||!integer(r.amountMinor)||typeof r.currency!=='string'||!/^[A-Z]{3}$/.test(r.currency)||!['initiated','submitting','provider_pending','uncertain','verified_test_only','failed'].includes(r.status))throw Error('Sandbox result unavailable');return r;}
 private checkout(value:any){const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.hash||u.port&&u.port!=='443'||!['test-checkout.korapay.com','checkout.korapay.com'].includes(u.hostname))throw Error('Sandbox checkout unavailable');return u.href;}
 private show(r:any){this.attemptId=r.attemptId;this.state.visible=true;this.state.status=r.status;this.state.canStart=false;
  this.state.message=r.status==='verified_test_only'?'Sandbox payment verified. No money was added to your wallet.':r.status==='failed'?'Sandbox payment failed. Your wallet balance is unchanged.':'Sandbox payment needs verification. No wallet credit has been applied.';}
 async initialize(){this.resetOwner();if(this.state.busy)return;const owner=this.owner;if(!owner)return;const epoch=this.epoch;this.admission=null;this.state.canStart=false;if(!this.attemptId)this.state.visible=false;this.state.busy=true;this.emit();
  try{
   const reference=this.deps.returnReference(),returnId=sandboxReferenceAttempt(reference);const saved=this.record(owner);const id=returnId||saved?.attemptId;
   if(id){const r=this.result(await this.deps.request('/sandbox-topups/'+id,'GET',null,owner),id);if(!this.current(owner,epoch))return;this.show(r);if(returnId){this.deps.save(this.key(owner),JSON.stringify({...saved,owner,key:saved?.key||this.deps.id(),attemptId:returnId}));this.deps.clearReturnReference();}
    if(!['verified_test_only','failed','initiated'].includes(r.status)){const verified=this.result(await this.deps.request('/sandbox-topups/'+id+'/reconcile','POST',{},owner),id);if(!this.current(owner,epoch))return;this.show(verified);}}
   const a=await this.deps.request('/sandbox-topups/eligibility','GET',null,owner);if(!this.current(owner,epoch))return;
   if(a?.eligible===true&&!validServerReturnOrigin(a.returnOrigin))throw Error('Sandbox return unavailable');
   if(a?.eligible===true&&(a.returnOrigin===this.deps.origin()||this.deps.native()||isWalletSandboxLoopback(this.deps.origin()))){if(a.ownerId!==owner||a.testOnly!==true||a.spendableCredit!==false||!integer(a.limitMinor)||!/^[A-Z]{3}$/.test(a.currency)||!Number.isInteger(a.minorExponent)||a.minorExponent<0||a.minorExponent>3)throw Error('Sandbox eligibility unavailable');this.admission=a;this.state.visible=true;this.state.amount=sandboxMoney(a.limitMinor,a.currency,a.minorExponent);this.state.canStart=!this.attemptId;}
  }catch{if(this.current(owner,epoch)&&this.state.visible)this.state.message='Sandbox status could not be verified. Retry without starting another payment.';}
  finally{if(this.current(owner,epoch)){this.state.busy=false;this.emit();}}
 }
 async start(){this.resetOwner();const owner=this.owner;if(!owner||this.state.busy||!this.admission||this.attemptId)return;
  const epoch=this.epoch;this.state.busy=true;this.emit();
  try{let r=this.record(owner);if(!r){r={owner,key:this.deps.id(),attemptId:null};if(!uuid(r.key))throw Error('Invalid key');this.deps.save(this.key(owner),JSON.stringify(r));}
   if(r.attemptId){this.attemptId=r.attemptId;throw Error('Reconcile existing attempt');}
   const result=this.result(await this.deps.request('/sandbox-topups','POST',{idempotencyKey:r.key,amountMinor:this.admission.limitMinor},owner));if(!this.current(owner,epoch))return;
   if(result.currency!==this.admission.currency||result.amountMinor!==this.admission.limitMinor)throw Error('Sandbox terms mismatch');
   const checkout=result.checkoutUrl?this.checkout(result.checkoutUrl):null;
   this.deps.save(this.key(owner),JSON.stringify({...r,attemptId:result.attemptId}));this.show(result);this.emit();if(checkout&&result.status==='provider_pending')await this.deps.redirect(checkout);
  }catch{if(this.current(owner,epoch))this.state.message='Sandbox checkout could not be completed. Check status before trying again.';}
  finally{if(this.current(owner,epoch)){this.state.busy=false;this.emit();}}
 }
 async check(){this.resetOwner();if(this.state.busy||!this.owner||!this.attemptId)return;const owner=this.owner,epoch=this.epoch,id=this.attemptId;this.state.busy=true;this.emit();try{const r=this.result(await this.deps.request('/sandbox-topups/'+id+'/reconcile','POST',{},owner),id);if(this.current(owner,epoch))this.show(r);}catch{if(this.current(owner,epoch))this.state.message='Sandbox status could not be verified. Your wallet balance is unchanged.';}finally{if(this.current(owner,epoch)){this.state.busy=false;this.emit();}}}
}
