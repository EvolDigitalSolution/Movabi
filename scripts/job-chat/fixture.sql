CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE ROLE authenticator NOINHERIT;
GRANT anon,authenticated,service_role TO authenticator;
CREATE SCHEMA auth;CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('test.user',true),'')::uuid $$;
GRANT USAGE ON SCHEMA auth TO authenticated;GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
CREATE TABLE jobs(id uuid PRIMARY KEY,customer_id uuid,driver_id uuid,accepted_driver_id uuid);
CREATE TABLE tenant_users(user_id uuid,tenant_id uuid,role text);
GRANT SELECT ON tenant_users TO authenticated;
CREATE TABLE job_messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid REFERENCES jobs(id),tenant_id uuid,sender_id uuid,receiver_id uuid,message text,read_at timestamptz,created_at timestamptz DEFAULT now());
ALTER TABLE job_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY job_messages_authenticated_select ON job_messages FOR SELECT TO authenticated USING(true);
CREATE POLICY job_messages_authenticated_insert ON job_messages FOR INSERT TO authenticated WITH CHECK(true);
CREATE POLICY "Admins can read messages for jobs in their tenant" ON job_messages FOR SELECT TO authenticated
 USING(EXISTS(SELECT 1 FROM tenant_users t WHERE t.user_id=auth.uid() AND t.role='admin' AND t.tenant_id=job_messages.tenant_id));
GRANT ALL ON job_messages TO anon,authenticated,service_role;
