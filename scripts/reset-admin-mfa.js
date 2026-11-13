'use strict';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function resetAdminMfa(pool, { userId, operator, ticket }) {
  if (!UUID_RE.test(String(userId || ''))) throw new Error('Identificativo account non valido.');
  if (typeof operator !== 'string' || !/^[\w .@-]{3,48}$/.test(operator.trim())) throw new Error('Identità operatore non valida.');
  if (typeof ticket !== 'string' || !/^[A-Za-z0-9._/-]{3,40}$/.test(ticket.trim())) throw new Error('Riferimento autorizzazione non valido.');
  const client = await pool.connect();
  let open = false;
  try {
    await client.query('BEGIN'); open = true;
    const found = await client.query('SELECT id, username, role, active FROM app_users WHERE id=$1 FOR UPDATE', [userId]);
    if (!found.rowCount) throw new Error('Account indicato non trovato.');
    const account = found.rows[0];
    if (account.role !== 'admin' || account.active !== true) throw new Error('Il recupero è consentito soltanto a un account amministratore attivo.');
    const admins = await client.query("SELECT COUNT(*)::int AS total FROM app_users WHERE role='admin' AND active=TRUE");
    if (admins.rows[0]?.total !== 1) throw new Error('Recupero bloccato: la procedura è riservata a installazioni con un solo amministratore attivo.');
    const sessions = await client.query('DELETE FROM app_sessions WHERE user_id=$1', [userId]);
    const challenges = await client.query('DELETE FROM app_mfa_challenges WHERE user_id=$1', [userId]);
    const updated = await client.query(
      'UPDATE app_users SET totp_secret_enc=NULL, totp_pending_secret_enc=NULL, totp_enabled_at=NULL, recovery_codes_hashes=$2, updated_at=NOW() WHERE id=$1 AND role=$3 AND active=TRUE RETURNING id',
      [userId, [], 'admin']
    );
    if (updated.rowCount !== 1) throw new Error('Account modificato durante il recupero: operazione annullata.');
    await client.query(
      "INSERT INTO audit_log(user_id, username, action, resource, resource_id) VALUES($1,$2,'security.mfa.emergency_reset','user',$3)",
      [userId, 'break-glass:' + operator.trim(), userId + ':' + ticket.trim()]
    );
    await client.query('COMMIT'); open = false;
    return { userId: account.id, username: account.username, revokedSessions: sessions.rowCount, revokedChallenges: challenges.rowCount };
  } catch (error) {
    if (open) { try { await client.query('ROLLBACK'); } catch (_e) {} }
    throw error;
  } finally { client.release(); }
}

function parseArgs(argv) {
  const values = {};
  for (let i=0; i<argv.length; i++) {
    const key=argv[i];
    if (!key.startsWith('--')) throw new Error('Argomento non riconosciuto: '+key);
    if (key==='--production') { values.production=true; continue; }
    const value=argv[++i];
    if (!value || value.startsWith('--')) throw new Error('Valore mancante per '+key);
    const name=key.slice(2);
    if (!['target-user-id','operator','ticket','backup-reference','database-name','environment'].includes(name)) throw new Error('Opzione non riconosciuta: '+key);
    values[name]=value;
  }
  for (const name of ['target-user-id','operator','ticket','backup-reference','database-name','environment']) if (!values[name]) throw new Error('Opzione obbligatoria mancante: --'+name);
  return values;
}

async function main() {
  const {Pool}=require('pg');
  const readline=require('node:readline/promises');
  require('dotenv').config();
  const args=parseArgs(process.argv.slice(2));
  if (!['test','staging','production'].includes(args.environment)) throw new Error('--environment deve essere test, staging o production.');
  if (args.environment==='production' && !args.production) throw new Error('Per produzione specificare anche --production.');
  if (args.environment!=='production' && args.production) throw new Error('--production è valido soltanto con --environment production.');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL non configurata.');
  if (args.environment==='production' && process.env.MFA_BREAK_GLASS_PRODUCTION_APPROVED!=='YES') throw new Error('Per produzione serve MFA_BREAK_GLASS_PRODUCTION_APPROVED=YES dopo approvazione formale.');
  const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.NODE_ENV==='production'?{rejectUnauthorized:false}:undefined,max:1});
  const rl=readline.createInterface({input:process.stdin,output:process.stdout});
  try {
    const db=await pool.query('SELECT current_database() AS name');
    if (db.rows[0].name!==args['database-name']) throw new Error('Database effettivo diverso da --database-name: nessuna modifica eseguita.');
    const phrase=(args.environment==='production'?'PRODUCTION ':'')+'RESET MFA FOR '+args['target-user-id']+' ON '+args['database-name'];
    process.stdout.write('\nAmbiente: '+args.environment+'\nOperatore: '+args.operator+'\nTicket: '+args.ticket+'\nBackup verificato: '+args['backup-reference']+'\nDatabase: '+db.rows[0].name+'\nAccount: '+args['target-user-id']+'\n');
    process.stdout.write('\nDigita esattamente "'+phrase+'" per confermare: ');
    if (await rl.question('')!==phrase) throw new Error('Conferma non corrispondente: nessuna modifica eseguita.');
    const result=await resetAdminMfa(pool,{userId:args['target-user-id'],operator:args.operator,ticket:args.ticket});
    process.stdout.write('\nRecupero completato per '+result.username+'. Sessioni revocate: '+result.revokedSessions+'; challenge revocate: '+result.revokedChallenges+'.\nL’account deve configurare nuovamente MFA al prossimo accesso.\n');
  } finally { rl.close(); await pool.end(); }
}
if (require.main===module) main().catch(error=>{process.stderr.write('Recupero MFA interrotto: '+error.message+'\n');process.exitCode=1;});
module.exports={resetAdminMfa,parseArgs};
