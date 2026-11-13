'use strict';
require('dotenv').config();
const {Client}=require('pg');
const crypto=require('node:crypto');
const {resetAdminMfa}=require('./reset-admin-mfa');
async function main() {
 if(!process.env.DATABASE_URL) throw Error('DATABASE_URL obbligatoria per il test PostgreSQL.');
 const client=new Client({connectionString:process.env.DATABASE_URL,ssl:process.env.NODE_ENV==='production'?{rejectUnauthorized:false}:undefined});
 await client.connect();
 const schema='mfa_break_glass_test_'+crypto.randomBytes(6).toString('hex');
 const pool={connect:async()=>({query:client.query.bind(client),release(){}})};
 try {
  await client.query('CREATE SCHEMA '+schema); await client.query('SET search_path TO '+schema);
  await client.query("CREATE TABLE app_users(id UUID PRIMARY KEY,username VARCHAR(60),role VARCHAR(24),active BOOLEAN,totp_secret_enc TEXT,totp_pending_secret_enc TEXT,totp_enabled_at TIMESTAMPTZ,recovery_codes_hashes TEXT[] NOT NULL DEFAULT '{}',updated_at TIMESTAMPTZ DEFAULT NOW())");
  await client.query('CREATE TABLE app_sessions(id UUID PRIMARY KEY,user_id UUID REFERENCES app_users(id) ON DELETE CASCADE)');
  await client.query('CREATE TABLE app_mfa_challenges(id UUID PRIMARY KEY,user_id UUID REFERENCES app_users(id) ON DELETE CASCADE)');
  await client.query('CREATE TABLE audit_log(id BIGSERIAL PRIMARY KEY,user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,username VARCHAR(60),action VARCHAR(120),resource VARCHAR(80),resource_id VARCHAR(80),ip_address INET,created_at TIMESTAMPTZ DEFAULT NOW())');
  const admin='11111111-1111-4111-8111-111111111111', other='22222222-2222-4222-8222-222222222222';
  await client.query("INSERT INTO app_users(id,username,role,active,totp_secret_enc,totp_pending_secret_enc,totp_enabled_at,recovery_codes_hashes) VALUES($1,'admin-test','admin',TRUE,'active','pending',NOW(),ARRAY['hash1','hash2']),($2,'manager-test','manager',TRUE,'manager-secret','manager-pending',NOW(),ARRAY['manager-hash'])",[admin,other]);
  await client.query("INSERT INTO app_sessions(id,user_id) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',$1),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',$2)",[admin,other]);
  await client.query("INSERT INTO app_mfa_challenges(id,user_id) VALUES('cccccccc-cccc-4ccc-8ccc-cccccccccccc',$1),('dddddddd-dddd-4ddd-8ddd-dddddddddddd',$2)",[admin,other]);
  const result=await resetAdminMfa(pool,{userId:admin,operator:'verified-owner',ticket:'INC-TEST-01'});
  if(result.revokedSessions!==1||result.revokedChallenges!==1) throw Error('Conteggio revoche inatteso.');
  const a=(await client.query('SELECT * FROM app_users WHERE id=$1',[admin])).rows[0];
  const o=(await client.query('SELECT * FROM app_users WHERE id=$1',[other])).rows[0];
  const sessions=(await client.query('SELECT COUNT(*)::int AS n FROM app_sessions WHERE user_id=$1',[admin])).rows[0].n;
  const challenges=(await client.query('SELECT COUNT(*)::int AS n FROM app_mfa_challenges WHERE user_id=$1',[admin])).rows[0].n;
  const audit=(await client.query('SELECT username,action,resource_id FROM audit_log WHERE user_id=$1',[admin])).rows[0];
  if(a.totp_secret_enc!==null||a.totp_pending_secret_enc!==null||a.totp_enabled_at!==null||a.recovery_codes_hashes.length!==0||sessions!==0||challenges!==0) throw Error('Reset MFA incompleto.');
  if(o.totp_secret_enc!=='manager-secret'||o.recovery_codes_hashes.length!==1) throw Error('Account non destinatario modificato.');
  if(!audit||audit.action!=='security.mfa.emergency_reset'||audit.username!=='break-glass:verified-owner'||audit.resource_id!==admin+':INC-TEST-01') throw Error('Audit log non corretto.');
  const secondAdmin='44444444-4444-4444-8444-444444444444';
  await client.query("INSERT INTO app_users(id,username,role,active) VALUES($1,'second-admin','admin',TRUE)",[secondAdmin]);
  let multipleAdminsBlocked=false;
  try { await resetAdminMfa(pool,{userId:admin,operator:'verified-owner',ticket:'INC-TEST-MULTI'}); } catch(e) { multipleAdminsBlocked=/un solo amministratore attivo/.test(e.message); }
  if(!multipleAdminsBlocked) throw Error('Il reset doveva essere bloccato con più amministratori attivi.');
  await client.query('DELETE FROM app_users WHERE id=$1',[secondAdmin]);
  const rollbackId='33333333-3333-4333-8333-333333333333';
  await client.query("INSERT INTO app_users(id,username,role,active,totp_secret_enc,totp_pending_secret_enc,totp_enabled_at,recovery_codes_hashes) VALUES($1,'rollback-admin','admin',TRUE,'keep-secret','keep-pending',NOW(),ARRAY['keep-hash'])",[rollbackId]);
  await client.query("INSERT INTO app_sessions(id,user_id) VALUES('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',$1)",[rollbackId]);
  await client.query("CREATE FUNCTION reject_break_glass_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced audit failure'; END; $$");
  await client.query("CREATE TRIGGER reject_break_glass_audit BEFORE INSERT ON audit_log FOR EACH ROW WHEN (NEW.user_id='33333333-3333-4333-8333-333333333333'::uuid) EXECUTE FUNCTION reject_break_glass_audit()");
  let failed=false;
  try { await resetAdminMfa(pool,{userId:rollbackId,operator:'verified-owner',ticket:'INC-TEST-02'}); } catch(_e) { failed=true; }
  const p=(await client.query('SELECT totp_secret_enc,totp_pending_secret_enc,recovery_codes_hashes FROM app_users WHERE id=$1',[rollbackId])).rows[0];
  const ps=(await client.query('SELECT COUNT(*)::int AS n FROM app_sessions WHERE user_id=$1',[rollbackId])).rows[0].n;
  if(!failed||p.totp_secret_enc!=='keep-secret'||p.totp_pending_secret_enc!=='keep-pending'||p.recovery_codes_hashes[0]!=='keep-hash'||ps!==1) throw Error('Rollback non ha preservato i dati MFA.');
  console.log('MFA break-glass PostgreSQL: reset, isolamento account, audit e rollback superati.');
 } finally {
  await client.query('SET search_path TO public'); await client.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE'); await client.end();
 }
}
main().catch(e=>{process.stderr.write('Test MFA break-glass fallito: '+e.message+'\n');process.exitCode=1;});
