const { Client } = require(process.env.MOVABI_PG_MODULE || 'pg');
class TestDatabase {
 constructor(){this.client=new Client({connectionString:process.env.MOVABI_TEST_DATABASE_URL});this.ready=this.client.connect();}
 async exec(sql){await this.ready;return this.client.query(sql);}
 async query(sql,args){await this.ready;return this.client.query(sql,args);}
 async close(){await this.client.end();}
}
const fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{
 const db=new TestDatabase();
 await db.exec(fs.readFileSync(__dirname+'/fixture.sql','utf8'));
 await db.exec(fs.readFileSync(__dirname+'/migration.sql','utf8'));
 const j='aaaaaaaa-aaaa-4aaa-8aaa-000000000001',d='bbbbbbbb-bbbb-4bbb-8bbb-000000000001',s='cccccccc-cccc-4ccc-8ccc-000000000001';
 await db.query("INSERT INTO service_types(id,slug) VALUES($1,'delivery')",[s]);
 await db.query("INSERT INTO jobs(id,service_type_id,metadata) VALUES($1,$2,'{}')",[j,s]);
 await db.query("INSERT INTO vehicles(user_id,type,capacity) VALUES($1,'car','standard')",[d]);
 let n=0;
 for(const service of ['delivery','errand'])for(const [required,actual,expected] of [
 ['bike','bike',true],['bike','car',true],['bike','small_van',true],['bike','large_van',true],
 ['car','bike',false],['car','car',true],['car','small_van',true],['small_van','car',false],
 ['small_van','small_van',true],['small_van','large_van',true],['large_van','small_van',false],
 ['large_van','large_van',true],['bike','unknown',false],['unknown','car',false]]){
 await db.query('UPDATE service_types SET slug=$1 WHERE id=$2',[service,s]);
 await db.query('UPDATE jobs SET metadata=$1::jsonb WHERE id=$2',[JSON.stringify({service_vehicle_class:required}),j]);
 await db.query("UPDATE vehicles SET type=$1,capacity='' WHERE user_id=$2",[actual,d]);
 const r=await db.query('SELECT driver_vehicle_can_accept_job($1,$2) AS ok',[j,d]);assert.equal(r.rows[0].ok,expected,`${service}: ${actual} for ${required}`);console.log(`PASS ${service}: ${actual} for ${required}`);n++;
 }
 await db.query("UPDATE service_types SET slug='ride' WHERE id=$1",[s]);
 await db.query("UPDATE vehicles SET type='car',capacity='standard' WHERE user_id=$1",[d]);
 for(const [required,expected] of [['bike',false],['standard',true],['xl',false]]){
 await db.query('UPDATE jobs SET metadata=$1::jsonb WHERE id=$2',[JSON.stringify({service_vehicle_class:required}),j]);const r=await db.query('SELECT driver_vehicle_can_accept_job($1,$2) AS ok',[j,d]);assert.equal(r.rows[0].ok,expected);n++;
 }
 await db.query('DELETE FROM vehicles');assert.equal((await db.query('SELECT driver_vehicle_can_accept_job($1,$2) AS ok',[j,d])).rows[0].ok,false);n++;
 const acl=await db.query("SELECT has_function_privilege('authenticated','driver_vehicle_can_accept_job(uuid,uuid)','EXECUTE') AS allowed");assert.equal(acl.rows[0].allowed,false);n++;
 console.log('DATABASE_CAPACITY_TESTS=PASS count='+n);await db.close();
})().catch(e=>{console.error(e);process.exit(1)});
