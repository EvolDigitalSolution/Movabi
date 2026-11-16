// Read-only authenticated develop/local diagnosis. Tokens are NEVER written or printed.
// Required: VAYDU_CUSTOMER_ACCESS_TOKEN. Optional: VAYDU_ADMIN_ACCESS_TOKEN, VAYDU_QUOTE_ID.
// Customer identity is confirmed by the server; decoded JWT subject only selects the admin row.
const allowed = new Set(['movabi-api-develop.apps.evolsolution.com','localhost','127.0.0.1']);
const base = new URL(process.env.VAYDU_API_URL || 'https://movabi-api-develop.apps.evolsolution.com');
if (!allowed.has(base.hostname) || !['https:','http:'].includes(base.protocol)
 || (base.hostname==='movabi-api-develop.apps.evolsolution.com'&&base.protocol!=='https:')
 || base.username || base.password) throw Error('Develop/local API required; remote access requires HTTPS');
if (!process.env.VAYDU_CUSTOMER_ACCESS_TOKEN) throw Error('An existing customer access token is required; no password/authentication retry is performed');
const token=process.env.VAYDU_CUSTOMER_ACCESS_TOKEN;
let customer=process.env.VAYDU_CUSTOMER_ID;
if(!customer){try{customer=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString()).sub;}catch{}}
async function request(path,access,body){
 const r=await fetch(new URL(path,base),{redirect:'error',method:body?'POST':'GET',headers:{authorization:'Bearer '+access,accept:'application/json',...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
 const text=await r.text();let data;try{data=JSON.parse(text);}catch{data={nonJsonBody:text.slice(0,200)};}
 return {status:r.status,body:data};
}
(async()=>{
 const wallet=await request('/api/payment/card-wallet',token);
 const out={api:base.origin,customerId:customer||null,cardWallet:{...wallet,body:{...wallet.body,
  ...(Array.isArray(wallet.body?.cards)?{cards:wallet.body.cards.map(c=>({brand:c.brand,last4:c.last4,expMonth:c.expMonth,expYear:c.expYear}))}:{})}}};
 if(process.env.VAYDU_ADMIN_ACCESS_TOKEN&&customer){
  const users=await request('/api/admin/users',process.env.VAYDU_ADMIN_ACCESS_TOKEN);
  if(users.status!==200||!Array.isArray(users.body))out.profile={status:users.status,error:'Admin profile lookup failed'};
  else{const p=users.body.find(p=>p.id===customer);out.profile=p?{id:p.id,tenantId:p.tenant_id,registrationCountry:p.registration_country_code,profileCountry:p.country_code,savedProfileCurrency:p.currency_code,
   note:'Persisted profile currency is not authority for a current booking or historical payment'}:{error:'Customer not found'};}
 }
 if(process.env.VAYDU_QUOTE_ID)out.cash=await request('/api/booking/cash/availability',token,{quoteId:process.env.VAYDU_QUOTE_ID});
 console.log(JSON.stringify(out,null,2));
 if(wallet.status!==200&&!(wallet.status===404&&wallet.body?.code==='SAVED_CARDS_DISABLED'))process.exitCode=1;
})().catch(()=>{console.error('Authenticated diagnosis could not complete; check the existing session and API access. No token or payment binding was changed.');process.exitCode=1;});
