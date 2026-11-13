'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createRouter = require('../tenant-inventory-tasks-routes');

function response() {
  return { statusCode:200, body:null, status(n){this.statusCode=n;return this;}, json(v){this.body=v;return this;} };
}
function handler(router,path,method) {
  const layer=router.stack.find(x=>x.route?.path===path&&x.route.methods[method]);
  assert.ok(layer,'missing '+method+' '+path);
  return layer.route.stack.at(-1).handle;
}
const tenant={companyId:'company-alpha',membershipId:'member-alpha',role:'admin'};
function poolWith(query, connect) { return {query,connect}; }

test('inventory list is company-scoped',async()=>{
 let call; const router=createRouter(poolWith(async(sql,args)=>{call={sql,args};return{rows:[]};},()=>{}));
 const res=response(); await handler(router,'/inventory','get')({tenant},res,e=>{throw e;});
 assert.match(call.sql,/FROM inventory_items WHERE company_id = \$1/); assert.deepEqual(call.args,['company-alpha']);
});

test('inventory creation rejects browser-supplied company id',async()=>{
 let called=false; const router=createRouter(poolWith(async()=>{called=true;},()=>{}));
 const res=response(); await handler(router,'/inventory','post')({tenant,body:{name:'Cassa',category:'Cofani',companyId:'company-beta'}},res,e=>{throw e;});
 assert.equal(res.statusCode,400); assert.equal(called,false);
});

test('stock movement locks and updates only tenant-owned item',async()=>{
 const calls=[];
 const client={query:async(sql,args)=>{calls.push({sql,args}); if(sql.startsWith('SELECT id, quantity'))return{rowCount:1,rows:[{quantity:'8'}]}; if(sql.startsWith('INSERT INTO stock_movements'))return{rowCount:1,rows:[{id:'m1'}]}; return{rowCount:1,rows:[]};},release(){}};
 const router=createRouter(poolWith(async()=>({rows:[]}),async()=>client));
 const res=response(); await handler(router,'/inventory/:id/movements','post')({tenant,params:{id:'11111111-1111-4111-8111-111111111111'},body:{movementType:'out',quantity:2}},res,e=>{throw e;});
 assert.equal(res.statusCode,201); assert.equal(res.body.quantity,6);
 assert.match(calls.find(x=>x.sql.startsWith('SELECT id, quantity')).sql,/company_id = \$2 FOR UPDATE/);
 assert.equal(calls.find(x=>x.sql.startsWith('INSERT INTO stock_movements')).args[0],'company-alpha');
});

test('stock movement prevents negative stock',async()=>{
 let inserted=false;
 const client={query:async(sql)=>{if(sql.startsWith('SELECT id, quantity'))return{rowCount:1,rows:[{quantity:'1'}]};if(sql.startsWith('INSERT INTO stock_movements'))inserted=true;return{rowCount:1,rows:[]};},release(){}};
 const router=createRouter(poolWith(async()=>({rows:[]}),async()=>client));
 const res=response(); await handler(router,'/inventory/:id/movements','post')({tenant,params:{id:'11111111-1111-4111-8111-111111111111'},body:{movementType:'out',quantity:2}},res,e=>{throw e;});
 assert.equal(res.statusCode,409); assert.equal(inserted,false);
});

test('tasks list scopes task and staff join to same tenant',async()=>{
 let call; const router=createRouter(poolWith(async(sql,args)=>{call={sql,args};return{rows:[]};},()=>{}));
 const res=response(); await handler(router,'/tasks','get')({tenant},res,e=>{throw e;});
 assert.match(call.sql,/s\.company_id = t\.company_id/); assert.match(call.sql,/WHERE t\.company_id = \$1/); assert.deepEqual(call.args,['company-alpha']);
});

test('task creation rejects foreign company id and does not query database',async()=>{
 let connected=false; const router=createRouter(poolWith(async()=>({rows:[]}),async()=>{connected=true;}));
 const res=response(); await handler(router,'/tasks','post')({tenant,body:{title:'Chiamare famiglia',companyId:'company-beta'}},res,e=>{throw e;});
 assert.equal(res.statusCode,400); assert.equal(connected,false);
});

test('task creation verifies linked case and staff against tenant',async()=>{
 const calls=[];
 const client={query:async(sql,args)=>{calls.push({sql,args});if(sql.startsWith('SELECT id FROM funeral_cases'))return{rowCount:1,rows:[{id:args[0]}]};if(sql.startsWith('SELECT id FROM staff'))return{rowCount:1,rows:[{id:args[0]}]};if(sql.startsWith('INSERT INTO tasks'))return{rowCount:1,rows:[{id:'t1'}]};return{rowCount:1,rows:[]};},release(){}};
 const router=createRouter(poolWith(async()=>({rows:[]}),async()=>client));
 const res=response(); await handler(router,'/tasks','post')({tenant,body:{title:'Preparare servizio',caseId:'11111111-1111-4111-8111-111111111111',assignedTo:'22222222-2222-4222-8222-222222222222'}},res,e=>{throw e;});
 assert.equal(res.statusCode,201);
 assert.ok(calls.some(x=>x.sql.includes('funeral_cases WHERE id=$1 AND company_id=$2')));
 assert.ok(calls.some(x=>x.sql.includes('staff WHERE id=$1 AND company_id=$2')));
 assert.equal(calls.find(x=>x.sql.startsWith('INSERT INTO tasks')).args[0],'company-alpha');
});

test('task update includes tenant id in WHERE clause',async()=>{
 let call; const client={query:async(sql,args)=>{if(sql.startsWith('UPDATE tasks')){call={sql,args};return{rowCount:1,rows:[{id:'t1'}]};}return{rowCount:1,rows:[]};},release(){}};
 const router=createRouter(poolWith(async()=>({rows:[]}),async()=>client));
 const res=response(); await handler(router,'/tasks/:id','patch')({tenant,params:{id:'33333333-3333-4333-8333-333333333333'},body:{status:'done'}},res,e=>{throw e;});
 assert.equal(res.statusCode,200); assert.match(call.sql,/WHERE id = \$2 AND company_id = \$3/); assert.equal(call.args.at(-1),'company-alpha');
});

test('tenant inventory rows include the low-stock field consumed by the UI', async () => {
  let sqlText = '';
  const router = createRouter(poolWith(async sql => { sqlText = sql; return { rows: [] }; }, () => {}));
  const res = response();
  await handler(router, '/inventory', 'get')({ tenant }, res, error => { throw error; });
  assert.match(sqlText, /quantity <= min_quantity/);
  assert.match(sqlText, /AS "lowStock"/);
});

test('tenant task rows expose staff name fields consumed by the UI', async () => {
  let sqlText = '';
  const router = createRouter(poolWith(async sql => { sqlText = sql; return { rows: [] }; }, () => {}));
  const res = response();
  await handler(router, '/tasks', 'get')({ tenant }, res, error => { throw error; });
  assert.match(sqlText, /AS "staffFirstName"/);
  assert.match(sqlText, /AS "staffLastName"/);
});
