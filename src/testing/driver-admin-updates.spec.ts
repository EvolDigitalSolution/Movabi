import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpileModule, ScriptTarget } from 'typescript';

const source = (file: string) => readFileSync(file, 'utf8');
const js = (code: string) => transpileModule(code, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
const response = () => ({ code: 200, body: null as any, status(code: number) { this.code = code; return this; }, json(body: any) { this.body = body; return this; } });
const verification = source('server/routes/verification.routes.ts');
const messaging = verification.slice(verification.indexOf("router.post('/drivers/:driverId/message'"), verification.indexOf("router.post('/drivers/:driverId/request-info'"));

async function send(message: string, options: {fail?:boolean;role?:string} = {}) {
    let handler: any;
    const writes: Array<{table:string;value:any}> = [];
    const supabase = {from(table:string) {
        const query:any = { select:()=>query, eq:()=>query,
            insert(value:any) { writes.push({table,value}); return query; },
            async single() { return table==='profiles' ? {data:{id:'driver',role:options.role || 'driver'}} : options.fail ? {error:new Error('Save failed')} : {data:{id:'message'}}; }
        }; return query;
    }};
    runInNewContext(js(messaging), {supabase, router:{post(_path:string, callback:any){handler=callback;}}, console:{error(){}}});
    const res=response();
    await handler({params:{driverId:'driver'},body:{message}},res);
    return {res,writes};
}

describe('Admin messages without document blockers', () => {
    it('saves one in-app message without changing the profile or requirements', async () => {
        const {res,writes}=await send('Please contact support.');
        expect(res.code).toBe(201);
        expect(writes).toHaveLength(1);
        expect(writes[0].table).toBe('notifications');
        expect(writes[0].value.data.action).toBe('admin_driver_message');
        expect(writes[0].value.user_id).toBe('driver');
    });
    it.each([' ', 'x'.repeat(2001)])('rejects empty or oversized messages', async message => {
        const {res,writes}=await send(message);expect(res.code).toBe(422);expect(writes).toHaveLength(0);
    });
    it('reports persistence failure',async()=>{expect((await send('Hello',{fail:true})).res.code).toBe(500);});
    it('rejects non-driver recipients',async()=>{expect((await send('Hello',{role:'customer'})).res.code).toBe(404);});
    it('keeps the endpoint behind the existing Admin guard',()=>{
        expect(verification.indexOf('router.use(requireAdmin)')).toBeLessThan(verification.indexOf("router.post('/drivers/:driverId/message'"));
    });
});

const onboarding=source('server/routes/driver-onboarding.routes.ts');
const start=onboarding.indexOf("router.put('/vehicle'");
const vehicleRoute=onboarding.slice(start,onboarding.indexOf('\n/**',start));
async function saveVehicle(options:{changed?:boolean;servicesChanged?:boolean;failReview?:boolean}={}) {
    let handler:any;const writes:Array<{table:string;value:any}>=[];
    const existing={id:'v',user_id:'d',type:'car',make:'Ford',model:'Focus',color:'blue',year:2020,license_plate:'AA20AAA',capacity:'standard',service_eligibility:['errand']};
    const input={vehicleType:options.changed?'bike':'car',make:'Ford',model:'Focus',colour:'blue',year:2020,registrationNumber:'AA20AAA',capacity:'standard',serviceEligibility:options.servicesChanged?['errand','delivery']:['errand']};
    const context={router:{put(_path:string,callback:any){handler=callback;}},console:{error(){}},authenticatedDriver:async()=> 'd',parseDriverVehicleInput:()=>input,currentVehicle:async()=>existing,mapDriverVehicleRow:(row:any)=>row,parseOnboardingItems:()=>({}),serializeOnboardingItems:(items:any)=>items,
        supabaseAdmin:{from(table:string){let updating=false;const query:any={
            select:()=>query,eq:()=>query,update(value:any){updating=true;writes.push({table,value});return query;},insert(value:any){writes.push({table,value});return query;},
            async single(){return table==='profiles'?{data:{id:'d',is_verified:true}}:{data:existing};},
            then(resolve:any){return Promise.resolve({error:options.failReview&&updating?new Error('Review failed'):null}).then(resolve);}
        };return query;}}
    };
    runInNewContext(js(vehicleRoute),context);const res=response();await handler({body:{}},res);return{res,writes};
}
describe('approved vehicle and service changes',()=>{
    it.each([{changed:true},{servicesChanged:true}])('requires review before changed details are saved',async options=>{
        const {res,writes}=await saveVehicle(options);expect(res.code).toBe(200);
        expect(writes[0].table).toBe('profiles');expect(writes[0].value.is_verified).toBe(false);expect(writes[0].value.is_online).toBe(false);
        expect(writes[1].table).toBe('vehicles');
    });
    it('preserves approval for unchanged details',async()=>{const{writes}=await saveVehicle();expect(writes).toHaveLength(1);expect(writes[0].table).toBe('vehicles');});
    it('does not save the new vehicle if review cannot be enforced',async()=>{const{res,writes}=await saveVehicle({changed:true,failReview:true});expect(res.code).toBe(500);expect(writes).toHaveLength(1);});
});
