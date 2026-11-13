'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {resetAdminMfa,parseArgs}=require('../scripts/reset-admin-mfa');
const id='11111111-1111-4111-8111-111111111111';
function pool({role='admin',active=true,failAudit=false}={}) {
 const calls=[];
 const client={async query(sql,args=[]) {
  calls.push({sql,args});
  if (['BEGIN','COMMIT','ROLLBACK'].includes(sql)) return {rowCount:0,rows:[]};
  if (sql.includes('FROM app_users WHERE id=$1 FOR UPDATE')) return {rowCount:1,rows:[{id,username:'admin-test',role,active}]};
  if (sql.startsWith('DELETE FROM app_sessions')) return {rowCount:2,rows:[]};
  if (sql.startsWith('DELETE FROM app_mfa_challenges')) return {rowCount:3,rows:[]};
  if (sql.startsWith('UPDATE app_users SET')) return {rowCount:1,rows:[{id}]};
  if (sql.includes('INSERT INTO audit_log')) { if(failAudit) throw Error('audit unavailable'); return {rowCount:1,rows:[]}; }
  throw Error('SQL inatteso: '+sql);
 },release(){calls.push({sql:'RELEASE'});}};
 return {calls,connect:async()=>client};
}
test('reset MFA revokes sessions/challenges and audits atomically',async()=>{
 const p=pool(); const r=await resetAdminMfa(p,{userId:id,operator:'verified-owner',ticket:'INC-123'});
 assert.deepEqual(r,{userId:id,username:'admin-test',revokedSessions:2,revokedChallenges:3});
 assert.ok(p.calls.some(x=>x.sql==='COMMIT')); assert.ok(p.calls.some(x=>x.sql.includes('totp_secret_enc=NULL')));
 assert.ok(p.calls.some(x=>x.sql.includes('recovery_codes_hashes=$2'))); assert.ok(p.calls.some(x=>x.sql.includes('INSERT INTO audit_log')));
});
test('reset MFA refuses non-admin and rolls back',async()=>{
 const p=pool({role:'manager'});
 await assert.rejects(resetAdminMfa(p,{userId:id,operator:'verified-owner',ticket:'INC-123'}),/account amministratore attivo/);
 assert.ok(p.calls.some(x=>x.sql==='ROLLBACK')); assert.equal(p.calls.some(x=>x.sql.startsWith('DELETE FROM app_sessions')),false);
});
test('audit failure rolls back reset',async()=>{
 const p=pool({failAudit:true});
 await assert.rejects(resetAdminMfa(p,{userId:id,operator:'verified-owner',ticket:'INC-123'}),/audit unavailable/);
 assert.ok(p.calls.some(x=>x.sql==='ROLLBACK')); assert.equal(p.calls.some(x=>x.sql==='COMMIT'),false);
});
test('rejects inactive admins and malformed operator identity',async()=>{
 await assert.rejects(resetAdminMfa(pool({active:false}),{userId:id,operator:'verified-owner',ticket:'INC-123'}),/account amministratore attivo/);
 await assert.rejects(resetAdminMfa(pool(),{userId:id,operator:'x',ticket:'INC-123'}),/Identità operatore/);
});
test('CLI arguments require target, operator, ticket, backup and database',()=>{
 assert.throws(()=>parseArgs([]),/Opzione obbligatoria mancante/);
 const a=parseArgs(['--target-user-id',id,'--operator','verified-owner','--ticket','INC-123','--backup-reference','backup-2026-11-13','--database-name','funeral_smart_test']);
 assert.equal(a['target-user-id'],id); assert.equal(a.production,undefined);
});
