import {Component} from '@angular/core';
import {RouterLink} from '@angular/router';
@Component({
 standalone:true,imports:[RouterLink],
 template:`<main class="min-h-screen bg-slate-50 p-6 flex items-center justify-center">
 <section class="bg-white rounded-2xl border border-slate-200 p-6 max-w-md space-y-4">
 <h1 class="text-xl font-bold">Return to your driver wallet</h1>
 <p>Payment still needs to be verified. Open your saved wallet attempt to check its status.</p>
 <a class="block bg-slate-950 text-white rounded-xl p-3 text-center" href="com.movabi.app://driver?topupReturn=1">Return to Vaydu app</a>
 <a class="block border rounded-xl p-3 text-center" routerLink="/driver" [queryParams]="{topupReturn:'1'}">Continue in this browser</a>
 </section></main>`
})
export class DriverTopupReturnPage {}
