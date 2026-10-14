import { supabaseAdmin } from './supabase.service';
import { GbMotService, GbVehicleLookup } from './gb-mot.service';

export class GbMotMonitorService {
 private static running=false;
 static londonClock(now=new Date()) {
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
  const get=(name:string)=>parts.find(p=>p.type===name)!.value;
  return {day:`${get('year')}-${get('month')}-${get('day')}`,minutes:Number(get('hour'))*60+Number(get('minute'))};
 }
 static start() {
  const timer=setInterval(()=>{void this.tick();},60000);timer.unref();void this.tick();
 }
 static async record(vehicleId:string,check:GbVehicleLookup) {
  const result=await supabaseAdmin.rpc('record_gb_vehicle_mot',{p_vehicle_id:vehicleId,p_registration:check.registration,p_status:check.motStatus,p_expiry:check.motExpiryDate,p_checked_at:check.checkedAt});
  if(result.error)throw Error('MOT compliance evidence could not be saved. Please retry.');
 }
 static async tick(now=new Date()) {
  const clock=this.londonClock(now);
  if(this.running||!GbMotService.enabled('GB')||clock.minutes<150)return;
  this.running=true;
  try {
   const expire=await supabaseAdmin.rpc('expire_gb_mot_online');
   if(expire.error)throw expire.error;
   // A database lease prevents replicas checking the same fleet concurrently.
   const claim=await supabaseAdmin.rpc('claim_gb_mot_night',{p_day:clock.day});
   if(claim.error)throw claim.error;if(!claim.data)return;
   let complete=true;
   for(let offset=0;;offset+=100) {
    const profiles=await supabaseAdmin.from('profiles').select('id').eq('country_code','GB').order('id').range(offset,offset+99);
    if(profiles.error)throw profiles.error;
    for(const profile of profiles.data||[]) {
     const vehicles=await supabaseAdmin.from('vehicles').select('id,type,license_plate').eq('user_id',profile.id);
     if(vehicles.error)throw vehicles.error;
     // Ambiguous ownership stays in the existing admin repair flow.
     if(vehicles.data?.length!==1)continue;
     const vehicle=vehicles.data[0];if(['motorcycle','bicycle','bike'].includes(String(vehicle.type).toLowerCase())||!vehicle.license_plate)continue;
     const previous=await supabaseAdmin.from('driver_vehicle_mot_checks').select('checked_at').eq('vehicle_id',vehicle.id).maybeSingle();
     if(previous.error)throw previous.error;
     if(previous.data && this.londonClock(new Date(previous.data.checked_at)).day===clock.day)continue;
     try {await this.record(vehicle.id,await GbMotService.lookup(vehicle.license_plate));}
     catch {complete=false;console.error('[GbMot] vehicle check unavailable',vehicle.id);}
    }
    if((profiles.data||[]).length<100)break;
   }
   if(complete){const finish=await supabaseAdmin.from('gb_mot_night_runs').update({completed:true}).eq('day',clock.day);if(finish.error)throw finish.error;}
  } catch {console.error('[GbMot] nightly monitor unavailable; existing restrictions retained');}
  finally {this.running=false;}
 }
}
