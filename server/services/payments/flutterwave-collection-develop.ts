import {constants,openSync,fstatSync,readFileSync,closeSync} from 'node:fs';
import {FlutterwaveCollectionSubaccount} from './flutterwave-collection-subaccount';

export const DEVELOP_COLLECTION_DRIVER='318e6be9-9164-41fa-bb0c-c5ccd3526585';
export const DEVELOP_COLLECTION_TENANT='d0e8e8e8-e8e8-e8e8-e8e8-d0e8e8e8e8e8';
export const DEVELOP_COLLECTION_FILE='/run/vaydu/flutterwave-test.env';
const reject=()=>new Error('Develop collection setup configuration rejected.');
const off=['VAYDU_DRIVER_PAYOUT_SANDBOX','VAYDU_DRIVER_TOPUP_API','VAYDU_FLUTTERWAVE_BOOKING_SPLIT_SANDBOX','VAYDU_BOOKING_SPLIT_TIMING_APPROVED'];

/** Strict provider-only file. No dotenv interpolation, process.env mutation or DB values. */
export function parseDevelopCollectionFile(source:string):Readonly<Record<string,string>>{
 const allowed=new Set(['FLUTTERWAVE_TEST_SECRET_KEY','FLUTTERWAVE_LIVE_SECRET_KEY','FLUTTERWAVE_COLLECTION_MERCHANT_REF',
  'DRIVER_SUBACCOUNT_FINGERPRINT_KEY','VAYDU_DRIVER_SUBACCOUNT_SANDBOX','VAYDU_FLUTTERWAVE_BOOKING_SPLIT_SANDBOX','VAYDU_BOOKING_SPLIT_TIMING_APPROVED']);
 const values:Record<string,string>={};
 for(const line of source.split(/\r?\n/)){
  if(!line||line.startsWith('#'))continue;
  const split=line.indexOf('=');const name=line.slice(0,split),value=line.slice(split+1);
  if(split<1||!allowed.has(name)||Object.prototype.hasOwnProperty.call(values,name)||/[\x00-\x1f\x7f]/.test(value))throw reject();
  values[name]=value;
 }
 if(!/^FLWSECK_TEST-[A-Za-z0-9_-]+$/.test(values.FLUTTERWAVE_TEST_SECRET_KEY||'')||values.FLUTTERWAVE_LIVE_SECRET_KEY
  ||! /^[A-Za-z0-9_.:-]{1,120}$/.test(values.FLUTTERWAVE_COLLECTION_MERCHANT_REF||'')
  ||(values.DRIVER_SUBACCOUNT_FINGERPRINT_KEY||'').length<32)throw reject();
 for(const name of ['VAYDU_DRIVER_SUBACCOUNT_SANDBOX','VAYDU_FLUTTERWAVE_BOOKING_SPLIT_SANDBOX','VAYDU_BOOKING_SPLIT_TIMING_APPROVED'])if(values[name]!=='false')throw reject();
 return Object.freeze(values);
}

/** Read once from the existing file mounted read-only. Errors never contain file contents. */
export function readDevelopCollectionFile(ownerUid:number):Readonly<Record<string,string>>{
 let fd:number|undefined;
 try{
  if(process.platform!=='linux'||!Number.isSafeInteger(ownerUid)||ownerUid<0)throw reject();
  fd=openSync(DEVELOP_COLLECTION_FILE,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const info=fstatSync(fd);
  if(!info.isFile()||(info.mode&0o777)!==0o600||info.uid!==ownerUid||info.size>16384)throw reject();
  const source=readFileSync(fd,'utf8');if(Buffer.byteLength(source,'utf8')>16384)throw reject();
  return parseDevelopCollectionFile(source);
 }catch{throw reject();}finally{if(fd!==undefined)closeSync(fd);}
}

export function confirmedDevelopCollectionScope(s:any){
 return s.driverId===DEVELOP_COLLECTION_DRIVER&&s.tenant===DEVELOP_COLLECTION_TENANT&&s.country==='NG'&&s.currency==='NGN';
}

/** Does not reconstruct or inspect DB credentials. targetUrl comes from the injected client. */
export function developCollectionProvider(targetUrl:string,env:NodeJS.ProcessEnv=process.env,
 readFile:(uid:number)=>Readonly<Record<string,string>>=readDevelopCollectionFile,request:typeof fetch=fetch){
 const names=['NODE_ENV','VAYDU_DEPLOYMENT_ENV','VAYDU_DRIVER_SUBACCOUNT_COHOST_DEVELOP','VAYDU_DRIVER_SUBACCOUNT_SANDBOX',
  'VAYDU_DRIVER_SUBACCOUNT_MERCHANT_VERIFIED','VAYDU_DRIVER_SUBACCOUNT_DEFAULT_APPROVED','VAYDU_DRIVER_SUBACCOUNT_FILE_OWNER_UID',
  'FLUTTERWAVE_LIVE_SECRET_KEY','FLUTTERWAVE_SECRET_KEY',...off];
 // Read only this feature's named settings: never enumerate/copy the application environment.
 const config=Object.freeze(Object.fromEntries(names.map(name=>[name,env[name]])));
 if(config.VAYDU_DRIVER_SUBACCOUNT_COHOST_DEVELOP!=='true'||config.VAYDU_DEPLOYMENT_ENV!=='develop')throw reject();
 if(!['production','test','development'].includes(config.NODE_ENV||''))throw reject();
 let target:string;try{target=new URL(targetUrl).href;}catch{throw reject();}
 if(!['http://movabi-develop-kong:8000/','https://movabi-supabase-develop.apps.evolsolution.com/'].includes(target))throw reject();
 for(const name of off)if(config[name]!==undefined&&config[name]!=='false')throw reject();
 if(config.FLUTTERWAVE_LIVE_SECRET_KEY||(config.FLUTTERWAVE_SECRET_KEY&&!/^FLWSECK_TEST-[A-Za-z0-9_-]+$/.test(config.FLUTTERWAVE_SECRET_KEY)))throw reject();
 // Disabled staging needs neither the file nor approval values and cannot issue requests.
 if(config.VAYDU_DRIVER_SUBACCOUNT_SANDBOX===undefined||config.VAYDU_DRIVER_SUBACCOUNT_SANDBOX==='false')return (_merchant?:string):FlutterwaveCollectionSubaccount=>{throw reject();};
 if(config.VAYDU_DRIVER_SUBACCOUNT_SANDBOX!=='true'||config.VAYDU_DRIVER_SUBACCOUNT_MERCHANT_VERIFIED!=='true'
  ||config.VAYDU_DRIVER_SUBACCOUNT_DEFAULT_APPROVED!=='true')throw reject();
 if(!/^(0|[1-9][0-9]*)$/.test(config.VAYDU_DRIVER_SUBACCOUNT_FILE_OWNER_UID||''))throw reject();
 const credentials=readFile(Number(config.VAYDU_DRIVER_SUBACCOUNT_FILE_OWNER_UID));
 // Revalidate injected loaders too. No arbitrary values or provider endpoint enter this factory.
 const values=parseDevelopCollectionFile(Object.entries(credentials).map(([k,v])=>k+'='+v).join('\n'));
 const provider=new FlutterwaveCollectionSubaccount(values.FLUTTERWAVE_TEST_SECRET_KEY,values.DRIVER_SUBACCOUNT_FINGERPRINT_KEY,request);
 return (merchant?:string)=>{if(merchant!==values.FLUTTERWAVE_COLLECTION_MERCHANT_REF)throw reject();return provider;};
}
