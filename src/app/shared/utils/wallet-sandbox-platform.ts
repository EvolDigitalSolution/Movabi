export function isWalletSandboxLoopback(origin:string):boolean{
 // Matches the deployed API's explicit browser CORS origins.
 return ['http://localhost:3000','http://localhost:4200','http://localhost:8100','https://localhost'].includes(origin);
}
export interface SandboxPlatformDeps{
 native():boolean;origin():string;openPopup():Window|null;openNative(url:string):Promise<void>;navigate(url:string):void;
 addFocus(callback:()=>void):void;removeFocus(callback:()=>void):void;
 listenFinished(callback:()=>void):Promise<{remove():Promise<void>|void}>;
}
/** Popup is created during a user click so localhost browsers don't block it. */
export class WalletSandboxPlatform{
 private deps:SandboxPlatformDeps;private popup:Window|null=null;private stopped=false;
 private nativeHandle:{remove():Promise<void>|void}|null=null;private focus=()=>{if(!this.stopped)this.onReturn();};
 private onReturn:()=>void;
 constructor(deps:SandboxPlatformDeps,onReturn:()=>void){this.deps=deps;this.onReturn=onReturn;}
 start(){this.stopped=false;if(this.deps.native()){
   void this.deps.listenFinished(this.focus).then(h=>{if(this.stopped){void Promise.resolve(h.remove()).catch(()=>undefined);}else this.nativeHandle=h;}).catch(()=>undefined);
  }else if(isWalletSandboxLoopback(this.deps.origin()))this.deps.addFocus(this.focus);
 }
 prepare(){if(!this.deps.native()&&isWalletSandboxLoopback(this.deps.origin())){
  this.popup=this.deps.openPopup();if(!this.popup)throw Error('POPUP_BLOCKED');this.popup.opener=null;
 }}
 async redirect(url:string){
  if(this.deps.native()){await this.deps.openNative(url);return;}
  if(isWalletSandboxLoopback(this.deps.origin())){if(!this.popup||this.popup.closed)throw Error('POPUP_CLOSED');this.popup.location.href=url;this.popup=null;return;}
  this.deps.navigate(url);
 }
 cleanupPopup(){if(this.popup&&!this.popup.closed)this.popup.close();this.popup=null;}
 stop(){this.stopped=true;this.cleanupPopup();this.deps.removeFocus(this.focus);if(this.nativeHandle){void Promise.resolve(this.nativeHandle.remove()).catch(()=>undefined);this.nativeHandle=null;}}
}

/** Store no tokens: only owner, idempotency key and attempt ID. */
export function walletSandboxStorage(native:boolean,origin:string,session:Storage,local:Storage){
 const durable=native||isWalletSandboxLoopback(origin);
 return {
  load(key:string){if(!durable)return session.getItem(key);const value=local.getItem(key);if(value!==null)return value;const legacy=session.getItem(key);if(legacy!==null)local.setItem(key,legacy);return legacy;},
  save(key:string,value:string){(durable?local:session).setItem(key,value);},
  remove(key:string){session.removeItem(key);if(durable)local.removeItem(key);}
 };
}
