'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { Pool } = require('pg');

const createTenantContext = require('../tenant-context');
const createCompanyContextRouter = require('../company-context-routes');
const createTenantCustomersCasesRouter = require('../tenant-customers-cases-routes');
const createTenantStaffVehiclesRouter = require('../tenant-staff-vehicles-routes');
const createTenantInventoryTasksRouter = require('../tenant-inventory-tasks-routes');
const createTenantInvoicesPaymentsRouter = require('../tenant-invoices-payments-routes');
const createTenantDashboardRouter = require('../tenant-dashboard-routes');
const createTenantCompanyAdminRouter = require('../tenant-company-admin-routes');
const createTenantAuditRouter = require('../tenant-audit-routes');
const createTenantInvitationRouter = require('../tenant-invitation-routes');

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined
  });
  const companyIds = [];
  const userIds = [];
  let server;

  try {
    const companyA = (await pool.query(
      "INSERT INTO companies(legal_name,city,province) VALUES('Tenant isolation A','Torino','TO') RETURNING id"
    )).rows[0].id;
    companyIds.push(companyA);
    const companyB = (await pool.query(
      "INSERT INTO companies(legal_name,city,province) VALUES('Tenant isolation B','Milano','MI') RETURNING id"
    )).rows[0].id;
    companyIds.push(companyB);

    const userA = (await pool.query(
      "INSERT INTO app_users(username,display_name,password_hash,role) VALUES($1,'Isolation User A','test-hash','admin') RETURNING id",
      ['tenant-isolation-a-' + crypto.randomUUID()]
    )).rows[0].id;
    userIds.push(userA);
    const userB = (await pool.query(
      "INSERT INTO app_users(username,display_name,password_hash,role) VALUES($1,'Isolation User B','test-hash','admin') RETURNING id",
      ['tenant-isolation-b-' + crypto.randomUUID()]
    )).rows[0].id;
    userIds.push(userB);

    const memberA = (await pool.query(
      "INSERT INTO company_memberships(company_id,user_id,role,status) VALUES($1,$2,'admin','active') RETURNING id",
      [companyA,userA]
    )).rows[0].id;
    const memberB = (await pool.query(
      "INSERT INTO company_memberships(company_id,user_id,role,status) VALUES($1,$2,'admin','active') RETURNING id",
      [companyB,userB]
    )).rows[0].id;

    const tokenA = crypto.randomBytes(32).toString('base64url');
    const tokenB = crypto.randomBytes(32).toString('base64url');
    await pool.query(
      "INSERT INTO app_sessions(user_id,token_hash,expires_at,active_membership_id) VALUES($1,$2,NOW()+INTERVAL '1 hour',$3),($4,$5,NOW()+INTERVAL '1 hour',$6)",
      [userA,hash(tokenA),memberA,userB,hash(tokenB),memberB]
    );

    async function seedTenant(companyId, suffix) {
      const customer = (await pool.query(
        'INSERT INTO customers(company_id,first_name,last_name) VALUES($1,$2,$3) RETURNING id',
        [companyId,'Cliente'+suffix,'Famiglia'+suffix]
      )).rows[0].id;
      const funeralCase = (await pool.query(
        'INSERT INTO funeral_cases(company_id,case_code,customer_id,deceased_first_name,deceased_last_name,service_type) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
        [companyId,'CASE-SHARED',customer,'Defunto'+suffix,'Cognome'+suffix,'Sepoltura']
      )).rows[0].id;
      const staff = (await pool.query(
        'INSERT INTO staff(company_id,first_name,last_name,role) VALUES($1,$2,$3,$4) RETURNING id',
        [companyId,'Operatore'+suffix,'Staff'+suffix,'Operatore']
      )).rows[0].id;
      const vehicle = (await pool.query(
        'INSERT INTO vehicles(company_id,plate,make_model) VALUES($1,$2,$3) RETURNING id',
        [companyId,suffix==='A'?'TA001AA':'TB002BB','Mezzo '+suffix]
      )).rows[0].id;
      const item = (await pool.query(
        'INSERT INTO inventory_items(company_id,sku,name,category,quantity,min_quantity,unit,unit_cost) VALUES($1,$2,$3,$4,5,1,\'pz\',10) RETURNING id',
        [companyId,'SKU-SHARED','Articolo '+suffix,'Materiale']
      )).rows[0].id;
      const task = (await pool.query(
        'INSERT INTO tasks(company_id,title,case_id,assigned_to) VALUES($1,$2,$3,$4) RETURNING id',
        [companyId,'Attività '+suffix,funeralCase,staff]
      )).rows[0].id;
      const invoice = (await pool.query(
        'INSERT INTO invoices(company_id,invoice_number,case_id,customer_id,amount,status) VALUES($1,$2,$3,$4,100,\'issued\') RETURNING id',
        [companyId,'FATT-SHARED',funeralCase,customer]
      )).rows[0].id;
      await pool.query(
        'INSERT INTO payments(company_id,invoice_id,amount,method) VALUES($1,$2,20,\'bonifico\')',
        [companyId,invoice]
      );
      return { customer, funeralCase, staff, vehicle, item, task, invoice };
    }

    const dataA = await seedTenant(companyA,'A');
    const dataB = await seedTenant(companyB,'B');
    for (const [companyId,userId,membershipId,suffix] of [[companyA,userA,memberA,'A'],[companyB,userB,memberB,'B']]) {
      await pool.query(
        "INSERT INTO audit_log(user_id,username,action,resource,resource_id,company_id,membership_id) VALUES($1,$2,$3,'test','isolation',$4,$5)",
        [userId,'tenant-'+suffix,'tenant.test.event.'+suffix,companyId,membershipId]
      );
      await pool.query(
        "INSERT INTO company_invitations(company_id,email,role,token_hash,invited_by_membership_id,expires_at) VALUES($1,$2,'operator',$3,$4,NOW()+INTERVAL '1 day')",
        [companyId,'invite-'+suffix.toLowerCase()+'@example.test',hash('invitation-'+suffix),membershipId]
      );
    }

    const tokenUsers = new Map([[tokenA,{id:userA,username:'tenant-a',mfaEnabled:true}],[tokenB,{id:userB,username:'tenant-b',mfaEnabled:true}]]);
    function authenticate(req,res,next) {
      const token = (req.headers.cookie || '').split(';').map(x=>x.trim()).find(x=>x.startsWith('fs_session='));
      const raw = token ? token.slice('fs_session='.length) : '';
      const user = tokenUsers.get(raw);
      if (!user) return res.status(401).json({error:'Unauthenticated'});
      req.cookies = { fs_session: raw };
      req.user = user;
      return next();
    }

    const tenantContext = createTenantContext(pool, hash);
    const app = express();
    app.use(express.json());
    app.use('/tenant', createCompanyContextRouter(pool, authenticate, hash));
    app.use('/tenant', authenticate, createTenantInvitationRouter({
      pool,
      sendInvitationEmail: async () => ({success:true}),
      publicAppUrl: 'https://funeral-smart.example',
      tenantContext
    }));
    app.use('/tenant', authenticate, tenantContext,
      createTenantCustomersCasesRouter(pool),
      createTenantStaffVehiclesRouter(pool),
      createTenantInventoryTasksRouter(pool),
      createTenantInvoicesPaymentsRouter(pool),
      createTenantDashboardRouter(pool),
      createTenantCompanyAdminRouter(pool),
      createTenantAuditRouter(pool)
    );
    app.use((error,_req,res,_next)=>res.status(500).json({error:error.message}));
    server = await new Promise(resolve => {
      const listener = app.listen(0,'127.0.0.1',()=>resolve(listener));
    });
    const base = 'http://127.0.0.1:'+server.address().port;
    async function call(token,path,options={}) {
      const response = await fetch(base+path,{
        ...options,
        headers:{Cookie:'fs_session='+token,...(options.body?{'Content-Type':'application/json'}:{}),...(options.headers||{})}
      });
      return {status:response.status,body:await response.json()};
    }

    for (const [token,companyId,suffix,data] of [[tokenA,companyA,'A',dataA],[tokenB,companyB,'B',dataB]]) {
      const endpoints = [
        ['/customers',row=>row.firstName==='Cliente'+suffix],
        ['/cases',row=>row.caseCode==='CASE-SHARED'],
        ['/staff',row=>row.firstName==='Operatore'+suffix],
        ['/vehicles',row=>row.makeModel==='Mezzo '+suffix],
        ['/inventory',row=>row.name==='Articolo '+suffix],
        ['/tasks',row=>row.title==='Attività '+suffix],
        ['/invoices',row=>row.invoiceNumber==='FATT-SHARED']
      ];
      for (const [path,match] of endpoints) {
        const result = await call(token,'/tenant'+path);
        assert.equal(result.status,200,path+' should succeed for tenant '+suffix);
        assert.equal(result.body.data.length,1,path+' must return exactly one tenant row');
        assert.ok(match(result.body.data[0]),path+' leaked or returned the wrong tenant data');
      }

      const profile = await call(token,'/tenant/company/profile');
      assert.equal(profile.status,200);
      assert.equal(profile.body.data.id,companyId);

      const members = await call(token,'/tenant/company/members');
      assert.equal(members.status,200);
      assert.equal(members.body.data.length,1);
      assert.equal(members.body.data[0].userId,suffix==='A'?userA:userB);

      const activity = await call(token,'/tenant/company/activity');
      assert.equal(activity.status,200);
      assert.equal(activity.body.data.length,1);
      assert.equal(activity.body.data[0].action,'tenant.test.event.'+suffix);

      const invitations = await call(token,'/tenant/company/invitations');
      assert.equal(invitations.status,200);
      assert.equal(invitations.body.data.length,1);
      assert.equal(invitations.body.data[0].email,'invite-'+suffix.toLowerCase()+'@example.test');

      const dashboard = await call(token,'/tenant/dashboard');
      assert.equal(dashboard.status,200);
      assert.equal(dashboard.body.data.customers.total,1);
      assert.equal(dashboard.body.data.cases.total,1);
      assert.equal(dashboard.body.data.activeStaff,1);
      assert.equal(dashboard.body.data.vehicles.total,1);
      assert.equal(dashboard.body.data.openTasks,1);
    }

    const crossTenantCase = await call(tokenA,'/tenant/cases',{
      method:'POST',
      body:JSON.stringify({
        caseCode:'CROSS-TENANT-ATTEMPT',
        customerId:dataB.customer,
        deceasedFirstName:'Test',
        deceasedLastName:'Cross',
        serviceType:'Sepoltura'
      })
    });
    assert.equal(crossTenantCase.status,400,'tenant A must not create a case linked to tenant B customer');

    const switchToOtherCompany = await call(tokenA,'/tenant/active-company',{
      method:'POST',
      body:JSON.stringify({companyId:companyB})
    });
    assert.equal(switchToOtherCompany.status,403,'tenant A must not activate tenant B');

    const afterDeniedSwitch = await call(tokenA,'/tenant/customers');
    assert.equal(afterDeniedSwitch.status,200);
    assert.equal(afterDeniedSwitch.body.data[0].firstName,'ClienteA');

    process.stdout.write('Tenant isolation OK: two companies cannot read each other\'s customers, cases, staff, vehicles, inventory, tasks, invoices, members, invitations, audit events, or dashboard totals.\n');
  } finally {
    if (server) await new Promise(resolve=>server.close(()=>resolve()));
    if (companyIds.length) {
      const ids = companyIds;
      await pool.query('DELETE FROM company_invitations WHERE company_id = ANY($1::uuid[])',[ids]);
      await pool.query('DELETE FROM audit_log WHERE company_id = ANY($1::uuid[])',[ids]);
      await pool.query('DELETE FROM app_sessions WHERE user_id = ANY($1::uuid[])',[userIds]);
      await pool.query('DELETE FROM payments WHERE company_id = ANY($1::uuid[])',[ids]);
      await pool.query('DELETE FROM invoices WHERE company_id = ANY($1::uuid[])',[ids]);
      await pool.query('DELETE FROM tasks WHERE company_id = ANY($1::uuid[])',[ids]);
      await pool.query('DELETE FROM stock_movements WHERE company_id = ANY($1::uuid[])',[ids]);
      await pool.query('DELETE FROM funeral_cases WHERE company_id = ANY($1::uuid[])',[ids]);
      await pool.query('DELETE FROM customers WHERE company_id = ANY($1::uuid[])',[ids]);
      await pool.query('DELETE FROM staff WHERE company_id = ANY($1::uuid[])',[ids]);
      await pool.query('DELETE FROM vehicles WHERE company_id = ANY($1::uuid[])',[ids]);
      await pool.query('DELETE FROM inventory_items WHERE company_id = ANY($1::uuid[])',[ids]);
      await pool.query('DELETE FROM company_memberships WHERE company_id = ANY($1::uuid[])',[ids]);
      if (userIds.length) await pool.query('DELETE FROM app_users WHERE id = ANY($1::uuid[])',[userIds]);
      await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])',[ids]);
    }
    await pool.end();
  }
}

main().catch(error=>{
  process.stderr.write(error.stack+'\n');
  process.exitCode=1;
});
