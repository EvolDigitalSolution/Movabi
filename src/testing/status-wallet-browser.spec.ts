import '@angular/compiler';
import {signal} from '@angular/core';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
const state=vi.hoisted(()=>({native:false,openBrowser:vi.fn(),listen:vi.fn()}));
vi.mock('@capacitor/core',()=>({Capacitor:{isNativePlatform:()=>state.native,getPlatform:()=>state.native?'android':'web'}}));
vi.mock('@capacitor/browser',()=>({Browser:{open:state.openBrowser,addListener:state.listen}}));
vi.mock('@ionic/angular',()=>({IonicModule:class {}}));
vi.mock('@ionic/angular/standalone',()=>new Proxy({},{get:(_target,key)=>key==='then'?undefined:class {},has:()=>true}));
import {ConnectService} from '../app/core/services/stripe/connect.service';
import {ActivityPage} from '../app/apps/mobile/features/customer/activity/activity.page';
import {EarningsPage} from '../app/apps/mobile/features/driver/earnings/earnings.page';
import {DriverDashboardPage} from '../app/apps/mobile/features/driver/dashboard/dashboard.page';
import {DriverSettingsPage} from '../app/apps/mobile/features/driver/settings.page';
const stripe='https://connect.stripe.com/express/test-login';
function tab(){return {closed:false,opener:{},document:{title:'',body:{textContent:''}},location:{href:'about:blank'},focus:vi.fn(),close:vi.fn()};}
function connect(){return Object.create(ConnectService.prototype) as ConnectService;}
beforeEach(()=>{state.native=false;state.openBrowser.mockReset().mockResolvedValue(undefined);state.listen.mockReset();});
afterEach(()=>vi.unstubAllGlobals());
describe('separate Stripe payout browsing',()=>{
 it('reserves a web tab synchronously and removes its opener',()=>{const target=tab(),open=vi.fn(()=>target);vi.stubGlobal('window',{open});expect(connect().prepareDashboardTab()).toBe(target);expect(open).toHaveBeenCalledWith('about:blank','_blank');expect(target.opener).toBeNull();expect(target.document.body.textContent).toContain('Stripe');});
 it('reports a popup blocker without replacing the app',()=>{const assign=vi.fn();vi.stubGlobal('window',{open:()=>null,location:{assign}});expect(()=>connect().prepareDashboardTab()).toThrow('Allow popups');expect(assign).not.toHaveBeenCalled();});
 it('navigates only the reserved Stripe tab, leaving the app intact',async()=>{const target=tab(),location={href:'https://movabi.test/driver'};vi.stubGlobal('window',{location});await connect().openDashboard(stripe,target as any);expect(target.location.href).toBe(stripe);expect(location.href).toBe('https://movabi.test/driver');expect(target.focus).toHaveBeenCalledOnce();});
 it('does not reopen a tab closed while the link was loading',async()=>{const target=tab();target.closed=true;await expect(connect().openDashboard(stripe,target as any)).rejects.toThrow('closed or blocked');});
 it.each(['http://connect.stripe.com/a','https://stripe.com.evil.test/a','https://evil.test/a','javascript:alert(1)','https://user:password@connect.stripe.com/a'])('rejects an unsafe payout target: %s',async(url)=>{const target=tab();await expect(connect().openDashboard(url,target as any)).rejects.toThrow('Invalid Stripe');expect(target.location.href).toBe('about:blank');expect(target.close).toHaveBeenCalledOnce();});
 it('uses Capacitor in-app browsing on mobile without a web popup',async()=>{state.native=true;const open=vi.fn();vi.stubGlobal('window',{open});const service=connect();expect(service.prepareDashboardTab()).toBeNull();await service.openDashboard(stripe,null);expect(state.openBrowser).toHaveBeenCalledWith({url:stripe,windowName:'_blank'});expect(open).not.toHaveBeenCalled();});
 it('surfaces native browser failures without navigating the app',async()=>{state.native=true;state.openBrowser.mockRejectedValue(Error('browser unavailable'));await expect(connect().openDashboard(stripe,null)).rejects.toThrow('browser unavailable');});
});
describe('payout entry point lifecycle',()=>{
 it('closes the earnings tab on a failed link request and clears busy state',async()=>{const page:any=Object.create(EarningsPage.prototype),target=tab();page.withdrawLoading=signal(false);page.withdrawError=signal(null);page.connectService={prepareDashboardTab:()=>target,getDashboardLink:vi.fn().mockRejectedValue(Error('offline'))};await page.withdrawFunds();expect(target.close).toHaveBeenCalledOnce();expect(page.withdrawLoading()).toBe(false);expect(page.withdrawError()).toBe('offline');});
 it('opens earnings via the authenticated shared account lookup and suppresses double clicks',async()=>{const page:any=Object.create(EarningsPage.prototype),target=tab();page.withdrawLoading=signal(false);page.withdrawError=signal(null);page.connectService={prepareDashboardTab:vi.fn(()=>target),getDashboardLink:vi.fn().mockResolvedValue({url:stripe}),openDashboard:vi.fn().mockResolvedValue(undefined)};await Promise.all([page.withdrawFunds(),page.withdrawFunds()]);expect(page.connectService.prepareDashboardTab).toHaveBeenCalledOnce();expect(page.connectService.getDashboardLink).toHaveBeenCalledWith('');expect(page.connectService.openDashboard).toHaveBeenCalledWith(stripe,target);expect(page.withdrawError()).toBeNull();});
 it('does not strand a reserved tab when the dashboard loading overlay fails',async()=>{const page:any=Object.create(DriverDashboardPage.prototype),target=tab();page.stripeUiState=()=>({accountId:'acct_driver'});page.connectService={prepareDashboardTab:()=>target};page.loadingCtrl={create:vi.fn().mockRejectedValue(Error('overlay unavailable'))};page.showToast=vi.fn();await page.openStripeDashboard();expect(target.close).toHaveBeenCalledOnce();expect(page.stripeDashboardOpening).toBe(false);});
 it('does not open a blank dashboard tab without a Stripe account',async()=>{const page:any=Object.create(DriverDashboardPage.prototype);page.stripeUiState=()=>({accountId:null});page.connectService={prepareDashboardTab:vi.fn()};page.showToast=vi.fn();await page.openStripeDashboard();expect(page.connectService.prepareDashboardTab).not.toHaveBeenCalled();});
 it('closes a reserved settings tab when fetching its link fails',async()=>{const page:any=Object.create(DriverSettingsPage.prototype),target=tab(),dismiss=vi.fn();page.loadingStripe=signal(false);page.driverService={stripeAccount:()=>({stripe_account_id:'acct_driver'})};page.connectService={prepareDashboardTab:()=>target,getDashboardLink:vi.fn().mockRejectedValue(Error('offline'))};page.loadingCtrl={create:async()=>({present:vi.fn(),dismiss})};page.showToast=vi.fn();await page.openStripeDashboard();expect(target.close).toHaveBeenCalledOnce();expect(dismiss).toHaveBeenCalledOnce();expect(page.loadingStripe()).toBe(false);});
});
describe('activity terminal labels',()=>{
 it('labels expired bookings explicitly without claiming a refund or completion',()=>{const page=Object.create(ActivityPage.prototype) as ActivityPage;expect(page.formatStatus('expired')).toBe('Expired');expect(page.formatStatus(' EXPIRED ')).toBe('Expired');expect(page.paymentStateLabel({status:'expired'} as any)).toBeNull();});
 it('keeps genuinely unrecognised values neutral',()=>{const page=Object.create(ActivityPage.prototype) as ActivityPage;expect(page.formatStatus('new_unrecognised_state')).toBe('Unknown status');expect(page.formatStatus(undefined)).toBe('Unknown status');});
});
