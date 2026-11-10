// @vitest-environment jsdom
import {describe,it,expect,vi} from 'vitest';
import {TestBed,ComponentFixture} from '@angular/core/testing';
import {BrowserTestingModule,platformBrowserTesting} from '@angular/platform-browser/testing';
import {provideZonelessChangeDetection} from '@angular/core';
import {of,throwError} from 'rxjs';
import {HttpClient} from '@angular/common/http';

TestBed.initTestEnvironment(BrowserTestingModule,platformBrowserTesting());
import {DriverPaymentAccountComponent} from '../app/shared/ui/driver-payment-account.component';
import {ApiUrlService} from '../app/core/services/api-url.service';
import {SupabaseService} from '../app/core/services/supabase/supabase.service';

const session={access_token:'t',user:{id:'d'}};
const httpGet=vi.fn();const httpPost=vi.fn();
function setup(status:any={provider:'flutterwave',state:'not_started',available:true,accountTypes:['bank']}){
 httpGet.mockReset();httpPost.mockReset();
 httpGet.mockImplementation((u:string)=>u.endsWith('/status')?of(status):of({banks:[{code:'044',name:'Access Bank'}]}));
 TestBed.configureTestingModule({imports:[DriverPaymentAccountComponent],providers:[
  provideZonelessChangeDetection(),
  {provide:HttpClient,useValue:{get:httpGet,post:httpPost}},
  {provide:ApiUrlService,useValue:{getApiUrl:(p:string)=>'http://api'+p}},
  {provide:SupabaseService,useValue:{auth:{getSession:async()=>({data:{session}})}}}]});
 const f=TestBed.createComponent(DriverPaymentAccountComponent);
 return f;
}
const buttons=(f:ComponentFixture<DriverPaymentAccountComponent>)=>Array.from(f.nativeElement.querySelectorAll('button')) as HTMLButtonElement[];
describe('driver payment-account component',()=>{
 it('renders distinct styled setup and refresh buttons',async()=>{
  const f=setup();await f.whenStable();f.detectChanges();
  const b=buttons(f).map(x=>x.textContent!.trim());
  expect(b).toContain('Set up bank account');expect(b).toContain('Refresh status');
  expect(b).not.toContain('Set up payment account');expect(b).not.toContain('Refresh');
 });
 it('opens the bank list successfully',async()=>{
  const f=setup();await f.whenStable();f.detectChanges();
  await f.componentInstance.open();f.detectChanges();
  expect(f.componentInstance.opened()).toBe(true);expect(f.componentInstance.banks()[0].name).toBe('Access Bank');
 });
 it('surfaces a 409 PAYMENT_ACCOUNT_SETUP_FAILED as an accessible alert',async()=>{
  const f=setup();await f.whenStable();f.detectChanges();
  httpGet.mockImplementationOnce(()=>throwError(()=>({status:409,error:{errorCode:'PAYMENT_ACCOUNT_SETUP_FAILED'}})));
  await f.componentInstance.open();f.detectChanges();
  const alert=f.nativeElement.querySelector('[role="alert"]');
  expect(alert).toBeTruthy();expect(alert.textContent).toContain('Setup could not be verified');
  expect(f.componentInstance.busy()).toBe(false);expect(f.componentInstance.opened()).toBe(false);
 });
 it('restores usable state and refresh recovers after failure',async()=>{
  const f=setup();await f.whenStable();f.detectChanges();
  httpGet.mockImplementationOnce(()=>throwError(()=>({status:500})));
  await f.componentInstance.refresh();f.detectChanges();
  expect(f.componentInstance.error()).toBeTruthy();
  await f.componentInstance.refresh();f.detectChanges();
  expect(f.componentInstance.error()).toBe('');expect(f.componentInstance.state()).toBe('not_started');
  expect(httpGet.mock.calls.length>=2).toBe(true);
 });
 it('does not resubmit setup while busy or without confirmation',async()=>{
  const f=setup();await f.whenStable();f.detectChanges();
  const c=f.componentInstance;c.busy.set(true);await c.save();
  c.busy.set(false);c.confirmed=false;await c.save();
  expect(httpPost).not.toHaveBeenCalled();
 });

 it('surfaces 429 rate-limit as a distinct accessible alert and starts a bounded cooldown',async()=>{
  const f=setup();await f.whenStable();f.detectChanges();
  await f.componentInstance.open();f.detectChanges();
  const c=f.componentInstance;c.bank='044';c.account='1234567890';
  httpPost.mockImplementationOnce(()=>throwError(()=>({status:429,error:{errorCode:'PAYMENT_ACCOUNT_RATE_LIMITED',retryAfterSeconds:45}})));
  await c.resolve();f.detectChanges();
  const alert=f.nativeElement.querySelector('[role="alert"]');
  expect(alert).toBeTruthy();expect(alert.textContent).toContain('Too many account checks');
  expect(c.cooldown()).toBe(45);expect(c.state()).not.toBe('completed');expect(c.reconcileOnly()).toBe(false);
 });
 it('cooldown blocks repeated resolve and expires without auto-submission',async()=>{
  const f=setup();await f.whenStable();f.detectChanges();
  await f.componentInstance.open();f.detectChanges();
  const c=f.componentInstance;c.bank='044';c.account='1234567890';c.cooldown.set(10);f.detectChanges();
  const btn=buttons(f).find(b=>b.textContent?.includes('Wait'))!;
  expect(btn.disabled).toBe(true);
  c.cooldown.set(0);f.detectChanges();
  const btn2=buttons(f).find(b=>b.textContent?.includes('Check account'))!;
  expect(btn2.disabled).toBe(false);
  expect(httpPost).not.toHaveBeenCalled();
 });
 it('resolve failure never displays already-submitted state',async()=>{
  const f=setup();await f.whenStable();f.detectChanges();
  await f.componentInstance.open();f.detectChanges();
  const c=f.componentInstance;c.bank='044';c.account='1234567890';
  httpPost.mockImplementationOnce(()=>throwError(()=>({status:429,error:{errorCode:'PAYMENT_ACCOUNT_RATE_LIMITED',retryAfterSeconds:5}})));
  await c.resolve();f.detectChanges();
  expect(c.reconcileOnly()).toBe(false);
  expect(f.nativeElement.textContent).not.toContain('already been submitted');
 });
});
