(()=>{
 'use strict';
 const ID='vaydu-wallet-entry';
 const SESSION='sb-movabi-supabase-develop-auth-token';
 const DRIVER='318e6be9-9164-41fa-bb0c-c5ccd3526585';
 const isHub=()=>/^\/driver(?:\/dashboard)?\/?$/.test(location.pathname);
 function show(){
  try{
   const session=JSON.parse(localStorage.getItem(SESSION)||'null');
   const allowed=isHub()&&session?.user?.id===DRIVER&&typeof session.access_token==='string'&&session.expires_at*1000>Date.now();
   if(!allowed){document.getElementById(ID)?.remove();return;}
   if(document.getElementById(ID))return;
   const link=document.createElement('a');
   link.id=ID;link.href='/driver-wallet-sandbox';link.textContent='Add wallet credit';
   link.setAttribute('aria-label','Add wallet credit');
   link.style.cssText='position:fixed;bottom:18px;right:18px;z-index:10000;background:#0f172a;color:white;padding:14px;border-radius:12px';
   document.body.appendChild(link);
  }catch{document.getElementById(ID)?.remove();}
 }
 // Navigation is independent of payout/onboarding status and is NOT availability.
 // The destination still requires backend authentication, market scope and gates.
 setInterval(show,1000);
 window.addEventListener('storage',show);
 window.addEventListener('popstate',show);
 show();
})();
