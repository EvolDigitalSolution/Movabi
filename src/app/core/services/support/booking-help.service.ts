import { AuthService } from '../auth/auth.service';
import { Injectable,inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { AlertController,ToastController } from '@ionic/angular';
import { firstValueFrom,timeout } from 'rxjs';
import { ApiUrlService } from '../api-url.service';
import { SupabaseService } from '../supabase/supabase.service';
import { BookingService } from '../booking/booking.service';
export type BookingSupportCategory='help'|'issue'|'payment'|'safety'|'lost_item';
@Injectable({providedIn:'root'})
export class BookingHelpService {
 private auth=inject(AuthService);
 private http=inject(HttpClient);private api=inject(ApiUrlService);private supabase=inject(SupabaseService);
 private alerts=inject(AlertController);private toasts=inject(ToastController);private bookings=inject(BookingService);
 private dialogOpen=false;
 private async headers(){const {data}=await this.supabase.auth.getSession();if(!data.session?.access_token)throw new Error('Please sign in again.');return {Authorization:`Bearer ${data.session.access_token}`};}
 async getHistory(id:string):Promise<any>{const userId=this.auth.currentUser()?.id;if(!userId)throw new Error('Please sign in again.');const result=await firstValueFrom(this.http.get(this.api.getApiUrl('/api/communication/history/'+encodeURIComponent(id)),{headers:await this.headers()}).pipe(timeout(20000)));if(userId!==this.auth.currentUser()?.id)throw new Error('Session changed. Please reload the booking.');return result;}
 private async toast(message:string){const t=await this.toasts.create({message,duration:5000});await t.present();}
 async openSupport(jobId:string,category:BookingSupportCategory='help'):Promise<void>{
  if(this.dialogOpen || !jobId)return;this.dialogOpen=true;
  let sending=false,requestId='',lastText='';const maxLength=category==='lost_item'?1500:2000;
  const names:Record<BookingSupportCategory,string>={help:'Get help',issue:'Report an issue',payment:'Payment help',safety:'Safety support',lost_item:'Report a lost item'};
  try {
   const alert=await this.alerts.create({header:names[category],backdropDismiss:false,
    message:category==='safety'?'If you are in immediate danger, contact local emergency services. This support form is not monitored as an emergency service.':category==='lost_item'?'Describe the item and where it was left. Movabi support will receive your report, and a message will be saved for your driver.':'Describe what happened. Your booking reference is included automatically.',
    inputs:[{name:'message',type:'textarea',placeholder:'Your message',attributes:{maxlength:maxLength,'aria-label':'Message to Movabi support'}}],
    buttons:[{text:'Cancel',role:'cancel',handler:()=>!sending},{text:'Send request',handler:async(values:any)=>{
     if(sending)return false;const message=String(values?.message || '').trim();
     if(message.length<3||message.length>maxLength){await this.toast(`Enter a message of 3–${maxLength} characters.`);return false;}
     sending=true;
     try{
      if(message!==lastText){requestId=crypto.randomUUID();lastText=message;}
      const result=await firstValueFrom(this.http.post<any>(this.api.getApiUrl('/api/communication/support'),{jobId,category,message,requestId},{headers:await this.headers()}).pipe(timeout(20000)));
      await this.toast(`Request received. Reference: ${result.id}. Admin email delivery is queued automatically.`);return true;
     }catch(error:any){await this.toast(error?.error?.error || error?.message || 'Could not save your request. Please retry.');return false;}
     finally{sending=false;}
    }}]});
   await alert.present();await alert.onDidDismiss();
  }finally{this.dialogOpen=false;}
 }
 async rate(jobId:string,existing?:{score:number;comment?:string}|null):Promise<boolean>{
  if(this.dialogOpen || !jobId)return false;this.dialogOpen=true;let saving=false,saved=false;
  try{
   const alert=await this.alerts.create({header:'Rate the service',backdropDismiss:false,
    inputs:[{name:'score',type:'number',placeholder:'Rating from 1 to 5',value:existing?.score,min:1,max:5,attributes:{step:1,'aria-label':'Rating from 1 to 5'}},{name:'comment',type:'textarea',placeholder:'Your review (optional)',value:existing?.comment || '',attributes:{maxlength:2000,'aria-label':'Review'}}],
    buttons:[{text:'Cancel',role:'cancel',handler:()=>!saving},{text:'Save rating',handler:async(values:any)=>{
     if(saving)return false;const score=Number(values?.score),comment=String(values?.comment || '').trim();
     if(!Number.isInteger(score)||score<1||score>5||comment.length>2000){await this.toast('Choose a whole-number rating from 1 to 5.');return false;}
     saving=true;try{await this.bookings.rateBooking(jobId,score,comment);saved=true;await this.toast('Your rating has been saved.');return true;}
     catch(error:any){await this.toast(error?.error?.error || 'Could not save your rating. Please retry.');return false;}finally{saving=false;}
    }}]});await alert.present();await alert.onDidDismiss();return saved;
  }finally{this.dialogOpen=false;}
 }
}
