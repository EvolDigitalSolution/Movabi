const { Client } = require(process.env.MOVABI_PG_MODULE || 'pg');
class TestDatabase {
 constructor(){this.client=new Client({connectionString:process.env.MOVABI_TEST_DATABASE_URL});this.ready=this.client.connect();}
 async exec(sql){await this.ready;return this.client.query(sql);}
 async query(sql,args){await this.ready;return this.client.query(sql,args);}
 async close(){await this.client.end();}
}
const fs=require('fs'),assert=require('node:assert/strict');
(async()=>{
 const db=new TestDatabase();await db.exec(fs.readFileSync(__dirname+'/fixture.sql','utf8'));await db.exec(fs.readFileSync(__dirname+'/migration.sql','utf8'));
 const j='aaaaaaaa-aaaa-4aaa-8aaa-000000000001',c='bbbbbbbb-bbbb-4bbb-8bbb-000000000001',d='cccccccc-cccc-4ccc-8ccc-000000000001',x='dddddddd-dddd-4ddd-8ddd-000000000001',t='eeeeeeee-eeee-4eee-8eee-000000000001';
 await db.query('INSERT INTO jobs VALUES($1,$2,$3,$3)',[j,c,d]);
 await db.query("INSERT INTO job_messages(job_id,tenant_id,sender_id,receiver_id,message) VALUES($1,$2,$3,$4,'Customer message'),($1,$2,$4,$3,'Driver reply')",[j,t,c,d]);
 const actor=async id=>{await db.exec('SET SESSION AUTHORIZATION postgres;SET ROLE postgres');await db.query("SELECT set_config('test.user',$1,false)",[id]);await db.exec('SET SESSION AUTHORIZATION authenticator;SET ROLE authenticated');};
 const reject=async(sql)=>{let failed=false;try{await db.exec(sql);}catch{failed=true;}assert(failed,'Expected denied write');};let n=0;
 for(const [id,count]of [[c,2],[d,2],[x,0]]){await actor(id);assert.equal((await db.query('SELECT count(*)::int AS n FROM job_messages')).rows[0].n,count);n++;}
 await actor(d);await db.exec('UPDATE job_messages SET read_at=now()');assert.equal((await db.query('SELECT count(*)::int AS n FROM job_messages WHERE read_at IS NOT NULL')).rows[0].n,1);n++;
 await reject("UPDATE job_messages SET message='Tampered'");n++;
 await reject("INSERT INTO job_messages(job_id,sender_id,receiver_id,message) VALUES('"+j+"','"+d+"','"+c+"','Spoofed')");n++;
 await reject('DELETE FROM job_messages');n++;
 await db.exec('SET SESSION AUTHORIZATION postgres;SET ROLE postgres');await db.query("INSERT INTO tenant_users VALUES($1,$2,'admin')",[x,t]);await actor(x);assert.equal((await db.query('SELECT count(*)::int AS n FROM job_messages')).rows[0].n,2);n++;
 await db.exec('SET SESSION AUTHORIZATION postgres;SET ROLE postgres');await db.exec('SET ROLE anon');await reject('SELECT * FROM job_messages');n++;
 await db.exec('SET ROLE postgres');const acl=await db.query("SELECT has_table_privilege('authenticated','job_messages','INSERT') AS insert_allowed,has_column_privilege('authenticated','job_messages','message','UPDATE') AS edit_allowed");assert.equal(acl.rows[0].insert_allowed,false);assert.equal(acl.rows[0].edit_allowed,false);n++;
 console.log('DATABASE_CHAT_TESTS=PASS count='+n);await db.close();
})().catch(e=>{console.error(e);process.exit(1)});
