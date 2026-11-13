'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { Pool } = require('pg');
const createCompanyContextRouter = require('../company-context-routes');

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined
  });
  const userId = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('base64url');
  const ids = { customers:[], cases:[], staff:[], vehicles:[], inventory:[], movements:[], tasks:[], invoices:[], payments:[] };
  let companyId = null;
  let server;

  try {
    const existing = await pool.query('SELECT id FROM companies LIMIT 1');
    if (existing.rowCount) throw new Error('Bootstrap integration test requires an empty companies table.');

    await pool.query(
      "INSERT INTO app_users(id,username,display_name,password_hash,role) VALUES($1,$2,'Legacy Admin','test-hash','admin')",
      [userId,'bootstrap-test-'+crypto.randomUUID()]
    );
    await pool.query(
      "INSERT INTO app_sessions(user_id,token_hash,expires_at) VALUES($1,$2,NOW()+INTERVAL '1 hour')",
      [userId,hash(token)]
    );

    ids.customers.push((await pool.query(
      "INSERT INTO customers(first_name,last_name) VALUES('Legacy','Customer') RETURNING id"
    )).rows[0].id);
    ids.cases.push((await pool.query(
      "INSERT INTO funeral_cases(case_code,customer_id,deceased_first_name,deceased_last_name,service_type) VALUES($1,$2,'Legacy','Deceased','Sepoltura') RETURNING id",
      ['BOOT-'+crypto.randomUUID().slice(0,8),ids.customers[0]]
    )).rows[0].id);
    ids.staff.push((await pool.query(
      "INSERT INTO staff(first_name,last_name,role) VALUES('Legacy','Staff','Operatore') RETURNING id"
    )).rows[0].id);
    ids.vehicles.push((await pool.query(
      "INSERT INTO vehicles(plate,make_model) VALUES($1,'Legacy Vehicle') RETURNING id",
      ['LB'+crypto.randomUUID().slice(0,6).toUpperCase()]
    )).rows[0].id);
    ids.inventory.push((await pool.query(
      "INSERT INTO inventory_items(name,category) VALUES('Legacy Item','Materiale') RETURNING id"
    )).rows[0].id);
    ids.movements.push((await pool.query(
      "INSERT INTO stock_movements(item_id,movement_type,quantity,reason) VALUES($1,'in',1,'bootstrap test') RETURNING id",
      [ids.inventory[0]]
    )).rows[0].id);
    ids.tasks.push((await pool.query(
      "INSERT INTO tasks(title,case_id,assigned_to) VALUES('Legacy Task',$1,$2) RETURNING id",
      [ids.cases[0],ids.staff[0]]
    )).rows[0].id);
    ids.invoices.push((await pool.query(
      "INSERT INTO invoices(invoice_number,case_id,customer_id,amount) VALUES($1,$2,$3,100) RETURNING id",
      ['BOOT-INV-'+crypto.randomUUID().slice(0,8),ids.cases[0],ids.customers[0]]
    )).rows[0].id);
    ids.payments.push((await pool.query(
      "INSERT INTO payments(invoice_id,amount,method) VALUES($1,10,'bonifico') RETURNING id",
      [ids.invoices[0]]
    )).rows[0].id);

    function authenticate(req,res,next) {
      const raw = (req.headers.cookie || '').split(';').map(x=>x.trim())
        .find(x=>x.startsWith('fs_session='));
      if (!raw || raw.slice('fs_session='.length) !== token) return res.status(401).json({error:'Unauthenticated'});
      req.cookies = { fs_session: token };
      req.user = { id:userId, username:'bootstrap-test', role:'admin' };
      return next();
    }

    const app = express();
    app.use(express.json());
    app.use('/tenant',createCompanyContextRouter(pool,authenticate,hash));
    app.use((error,_req,res,_next)=>res.status(500).json({error:error.message}));
    server = await new Promise(resolve=>{
      const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));
    });
    const response = await fetch('http://127.0.0.1:'+server.address().port+'/tenant/companies/bootstrap',{
      method:'POST',
      headers:{Cookie:'fs_session='+token,'Content-Type':'application/json'},
      body:JSON.stringify({
        legalName:'Impresa iniziale di test',
        city:'Torino',
        province:'TO',
        confirmLegacyDataOwnership:true
      })
    });
    const body = await response.json();
    assert.equal(response.status,201,JSON.stringify(body));
    companyId = body.data.id;
    assert.equal(body.data.role,'admin');
    assert.equal(body.data.legalName,'Impresa iniziale di test');
    for (const table of ['customers','funeral_cases','staff','vehicles','inventory_items','stock_movements','tasks','invoices','payments']) {
      assert.equal(body.backfilled[table],1,'expected one legacy row to be assigned in '+table);
      const result = await pool.query('SELECT company_id FROM '+table+' WHERE id=$1',[ids[table==='funeral_cases'?'cases':table==='inventory_items'?'inventory':table==='stock_movements'?'movements':table][0]]);
      assert.equal(result.rows[0].company_id,companyId,'legacy row was not assigned in '+table);
    }
    const session = await pool.query(
      'SELECT s.active_membership_id,m.company_id,m.role FROM app_sessions s JOIN company_memberships m ON m.id=s.active_membership_id WHERE s.user_id=$1 AND s.token_hash=$2',
      [userId,hash(token)]
    );
    assert.equal(session.rowCount,1);
    assert.equal(session.rows[0].company_id,companyId);
    assert.equal(session.rows[0].role,'admin');
    const audit = await pool.query(
      "SELECT action FROM audit_log WHERE user_id=$1 AND company_id=$2",
      [userId,companyId]
    );
    assert.equal(audit.rows[0].action,'company.initial_bootstrap');

    const second = await fetch('http://127.0.0.1:'+server.address().port+'/tenant/companies/bootstrap',{
      method:'POST',
      headers:{Cookie:'fs_session='+token,'Content-Type':'application/json'},
      body:JSON.stringify({legalName:'Second company',confirmLegacyDataOwnership:true})
    });
    assert.equal(second.status,409,'initial bootstrap must be one-time only');

    process.stdout.write('Initial company bootstrap OK: legacy rows were assigned atomically, the admin membership and active session were created, and the audit event was written.\n');
  } finally {
    if(server) await new Promise(resolve=>server.close(()=>resolve()));
    await pool.query('DELETE FROM audit_log WHERE user_id=$1',[userId]);
    await pool.query('DELETE FROM app_sessions WHERE user_id=$1',[userId]);
    await pool.query('DELETE FROM company_invitations WHERE invited_by_membership_id IN (SELECT id FROM company_memberships WHERE user_id=$1)',[userId]);
    await pool.query('DELETE FROM stock_movements WHERE id=ANY($1::uuid[])',[ids.movements]);
    await pool.query('DELETE FROM payments WHERE id=ANY($1::uuid[])',[ids.payments]);
    await pool.query('DELETE FROM invoices WHERE id=ANY($1::uuid[])',[ids.invoices]);
    await pool.query('DELETE FROM tasks WHERE id=ANY($1::uuid[])',[ids.tasks]);
    await pool.query('DELETE FROM funeral_cases WHERE id=ANY($1::uuid[])',[ids.cases]);
    await pool.query('DELETE FROM customers WHERE id=ANY($1::uuid[])',[ids.customers]);
    await pool.query('DELETE FROM staff WHERE id=ANY($1::uuid[])',[ids.staff]);
    await pool.query('DELETE FROM vehicles WHERE id=ANY($1::uuid[])',[ids.vehicles]);
    await pool.query('DELETE FROM inventory_items WHERE id=ANY($1::uuid[])',[ids.inventory]);
    await pool.query('DELETE FROM company_memberships WHERE user_id=$1',[userId]);
    await pool.query('DELETE FROM app_users WHERE id=$1',[userId]);
    if(companyId) await pool.query('DELETE FROM companies WHERE id=$1',[companyId]);
    await pool.end();
  }
}

main().catch(error=>{
  process.stderr.write(error.stack+'\n');
  process.exitCode=1;
});
