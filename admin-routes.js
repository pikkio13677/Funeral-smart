'use strict';
const express = require('express');
const { z } = require('zod');

module.exports = function createAdminRouter(pool, adminOnly) {
  const router = express.Router();
  router.use(adminOnly);

  const text = (max, min = 0) => z.string().trim().min(min).max(max);
  const optionalText = max => z.string().trim().max(max).optional().nullable();
  const money = z.number().nonnegative().max(10000000);
  const dateText = z.string().trim().min(1).max(40).optional().nullable();

  const customerSchema = z.object({
    firstName: text(100, 1), lastName: text(100, 1),
    phone: optionalText(40), email: z.string().trim().email().max(254).optional().nullable().or(z.literal('')),
    address: optionalText(500), notes: optionalText(1500)
  });
  const caseSchema = z.object({
    caseCode: text(40, 1), customerId: z.string().uuid().optional().nullable(),
    deceasedFirstName: text(100, 1), deceasedLastName: text(100, 1),
    dateOfDeath: dateText, serviceType: text(80, 1), serviceDate: dateText,
    location: optionalText(180), destination: optionalText(180),
    status: z.enum(['open','planned','in_progress','completed','cancelled']).optional(),
    estimatedTotal: money.optional().default(0), notes: optionalText(2000)
  });
  const staffSchema = z.object({
    firstName: text(100, 1), lastName: text(100, 1), role: text(100, 1),
    phone: optionalText(40), email: z.string().trim().email().max(254).optional().nullable().or(z.literal('')),
    active: z.boolean().optional().default(true)
  });
  const vehicleSchema = z.object({
    plate: text(20, 1), makeModel: text(120, 1), vehicleType: text(80, 1).optional().default('Funebre'),
    status: z.enum(['available','assigned','maintenance','inactive']).optional().default('available'),
    nextMaintenance: dateText, notes: optionalText(1000)
  });
  const inventorySchema = z.object({
    sku: optionalText(60), name: text(160, 1), category: text(100, 1),
    quantity: z.number().nonnegative().max(100000000).optional().default(0),
    minQuantity: z.number().nonnegative().max(100000000).optional().default(0),
    unit: text(30, 1).optional().default('pz'), unitCost: money.optional().default(0)
  });
  const taskSchema = z.object({
    title: text(180, 1), description: optionalText(1500), dueDate: dateText,
    priority: z.enum(['low','normal','high','urgent']).optional().default('normal'),
    status: z.enum(['open','in_progress','done','cancelled']).optional().default('open'),
    caseId: z.string().uuid().optional().nullable(), assignedTo: z.string().uuid().optional().nullable()
  });
  const invoiceSchema = z.object({
    invoiceNumber: text(60, 1), caseId: z.string().uuid().optional().nullable(),
    customerId: z.string().uuid().optional().nullable(), issueDate: dateText,
    dueDate: dateText, amount: money, status: z.enum(['draft','issued','partial','paid','overdue','cancelled']).optional().default('draft'),
    notes: optionalText(1000)
  });
  const paymentSchema = z.object({
    amount: z.number().positive().max(10000000), paymentDate: dateText,
    method: text(40, 1), reference: optionalText(120)
  });

  const fail = (res, parsed) => res.status(400).json({
    error: 'Dati non validi',
    details: parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message }))
  });

  router.get('/dashboard', async (_req, res, next) => {
    try {
      const [cases, customers, staff, vehicles, stock, tasks, invoices] = await Promise.all([
        pool.query("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status IN ('open','planned','in_progress'))::int AS active FROM funeral_cases"),
        pool.query('SELECT COUNT(*)::int AS total FROM customers'),
        pool.query('SELECT COUNT(*)::int AS total FROM staff WHERE active = TRUE'),
        pool.query("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='available')::int AS available FROM vehicles"),
        pool.query('SELECT COUNT(*) FILTER (WHERE quantity <= min_quantity)::int AS low FROM inventory_items'),
        pool.query("SELECT COUNT(*)::int AS open FROM tasks WHERE status IN ('open','in_progress')"),
        pool.query("SELECT COALESCE(SUM(amount),0)::numeric(12,2) AS outstanding FROM invoices WHERE status IN ('issued','partial','overdue')")
      ]);
      res.json({ data: {
        cases: cases.rows[0], customers: customers.rows[0], activeStaff: staff.rows[0].total,
        vehicles: vehicles.rows[0], lowStock: stock.rows[0].low, openTasks: tasks.rows[0].open,
        outstandingEuro: invoices.rows[0].outstanding
      }});
    } catch (e) { next(e); }
  });

  router.get('/customers', async (_req,res,next) => {
    try { const r=await pool.query('SELECT id, first_name AS "firstName", last_name AS "lastName", phone, email, address, notes, created_at AS "createdAt" FROM customers ORDER BY created_at DESC LIMIT 300'); res.json({data:r.rows}); } catch(e){next(e);}
  });
  router.post('/customers', async (req,res,next) => {
    const p=customerSchema.safeParse(req.body); if(!p.success)return fail(res,p); const v=p.data;
    try { const r=await pool.query('INSERT INTO customers(first_name,last_name,phone,email,address,notes) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,first_name AS "firstName",last_name AS "lastName",phone,email,address,notes,created_at AS "createdAt"', [v.firstName,v.lastName,v.phone||null,v.email||null,v.address||null,v.notes||null]); res.status(201).json({data:r.rows[0]}); } catch(e){next(e);}
  });

  router.get('/cases', async (_req,res,next) => {
    try { const r=await pool.query('SELECT f.id,f.case_code AS "caseCode",f.deceased_first_name AS "deceasedFirstName",f.deceased_last_name AS "deceasedLastName",f.date_of_death AS "dateOfDeath",f.service_type AS "serviceType",f.service_date AS "serviceDate",f.location,f.destination,f.status,f.estimated_total AS "estimatedTotal",f.notes,c.first_name AS "customerFirstName",c.last_name AS "customerLastName" FROM funeral_cases f LEFT JOIN customers c ON c.id=f.customer_id ORDER BY f.created_at DESC LIMIT 300'); res.json({data:r.rows}); } catch(e){next(e);}
  });
  router.post('/cases', async (req,res,next) => {
    const p=caseSchema.safeParse(req.body); if(!p.success)return fail(res,p); const v=p.data;
    try { const r=await pool.query('INSERT INTO funeral_cases(case_code,customer_id,deceased_first_name,deceased_last_name,date_of_death,service_type,service_date,location,destination,status,estimated_total,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id,case_code AS "caseCode",status', [v.caseCode,v.customerId||null,v.deceasedFirstName,v.deceasedLastName,v.dateOfDeath||null,v.serviceType,v.serviceDate||null,v.location||null,v.destination||null,v.status||'open',v.estimatedTotal,v.notes||null]); res.status(201).json({data:r.rows[0]}); } catch(e){if(e.code==='23505')return res.status(409).json({error:'Codice pratica già utilizzato.'});next(e);}
  });
  router.patch('/cases/:id/status', async (req,res,next) => {
    const p=z.object({status:z.enum(['open','planned','in_progress','completed','cancelled'])}).safeParse(req.body);if(!p.success)return fail(res,p);
    try{const r=await pool.query('UPDATE funeral_cases SET status=$1,updated_at=NOW() WHERE id=$2 RETURNING id,status',[p.data.status,req.params.id]);if(!r.rowCount)return res.status(404).json({error:'Pratica non trovata'});res.json({data:r.rows[0]});}catch(e){next(e);}
  });

  router.get('/staff', async (_req,res,next)=>{try{const r=await pool.query('SELECT id,first_name AS "firstName",last_name AS "lastName",role,phone,email,active FROM staff ORDER BY last_name,first_name');res.json({data:r.rows});}catch(e){next(e);}});
  router.post('/staff', async(req,res,next)=>{const p=staffSchema.safeParse(req.body);if(!p.success)return fail(res,p);const v=p.data;try{const r=await pool.query('INSERT INTO staff(first_name,last_name,role,phone,email,active) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,first_name AS "firstName",last_name AS "lastName",role,phone,email,active',[v.firstName,v.lastName,v.role,v.phone||null,v.email||null,v.active]);res.status(201).json({data:r.rows[0]});}catch(e){next(e);}});

  router.get('/vehicles', async(_req,res,next)=>{try{const r=await pool.query('SELECT id,plate,make_model AS "makeModel",vehicle_type AS "vehicleType",status,next_maintenance AS "nextMaintenance",notes FROM vehicles ORDER BY plate');res.json({data:r.rows});}catch(e){next(e);}});
  router.post('/vehicles', async(req,res,next)=>{const p=vehicleSchema.safeParse(req.body);if(!p.success)return fail(res,p);const v=p.data;try{const r=await pool.query('INSERT INTO vehicles(plate,make_model,vehicle_type,status,next_maintenance,notes) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,plate,make_model AS "makeModel",vehicle_type AS "vehicleType",status,next_maintenance AS "nextMaintenance",notes',[v.plate.toUpperCase(),v.makeModel,v.vehicleType,v.status,v.nextMaintenance||null,v.notes||null]);res.status(201).json({data:r.rows[0]});}catch(e){if(e.code==='23505')return res.status(409).json({error:'Targa già registrata.'});next(e);}});

  router.get('/inventory', async(_req,res,next)=>{try{const r=await pool.query('SELECT id,sku,name,category,quantity,min_quantity AS "minQuantity",unit,unit_cost AS "unitCost",(quantity<=min_quantity) AS "lowStock" FROM inventory_items ORDER BY category,name');res.json({data:r.rows});}catch(e){next(e);}});
  router.post('/inventory', async(req,res,next)=>{const p=inventorySchema.safeParse(req.body);if(!p.success)return fail(res,p);const v=p.data;try{const r=await pool.query('INSERT INTO inventory_items(sku,name,category,quantity,min_quantity,unit,unit_cost) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,sku,name,category,quantity,min_quantity AS "minQuantity",unit,unit_cost AS "unitCost"', [v.sku||null,v.name,v.category,v.quantity,v.minQuantity,v.unit,v.unitCost]);res.status(201).json({data:r.rows[0]});}catch(e){if(e.code==='23505')return res.status(409).json({error:'Codice articolo già utilizzato.'});next(e);}});
  router.post('/inventory/:id/movements', async(req,res,next)=>{
    const p=z.object({movementType:z.enum(['in','out']),quantity:z.number().positive().max(1000000),reason:optionalText(300),caseId:z.string().uuid().optional().nullable()}).safeParse(req.body);if(!p.success)return fail(res,p);const v=p.data;const client=await pool.connect();
    try{await client.query('BEGIN');const item=await client.query('SELECT id,quantity FROM inventory_items WHERE id=$1 FOR UPDATE',[req.params.id]);if(!item.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Articolo non trovato'});}const delta=v.movementType==='in'?v.quantity:-v.quantity;const newQty=Number(item.rows[0].quantity)+delta;if(newQty<0){await client.query('ROLLBACK');return res.status(409).json({error:'Giacenza insufficiente'});}await client.query('UPDATE inventory_items SET quantity=$1,updated_at=NOW() WHERE id=$2',[newQty,req.params.id]);const movement=await client.query('INSERT INTO stock_movements(item_id,movement_type,quantity,reason,case_id) VALUES($1,$2,$3,$4,$5) RETURNING id,item_id AS "itemId",movement_type AS "movementType",quantity,reason,created_at AS "createdAt"',[req.params.id,v.movementType,v.quantity,v.reason||null,v.caseId||null]);await client.query('COMMIT');res.status(201).json({data:movement.rows[0],newQuantity:newQty});}catch(e){await client.query('ROLLBACK');next(e);}finally{client.release();}
  });

  router.get('/tasks',async(_req,res,next)=>{try{const r=await pool.query('SELECT t.id,t.title,t.description,t.due_date AS "dueDate",t.priority,t.status,t.case_id AS "caseId",t.assigned_to AS "assignedTo",s.first_name AS "staffFirstName",s.last_name AS "staffLastName" FROM tasks t LEFT JOIN staff s ON s.id=t.assigned_to ORDER BY CASE t.priority WHEN \'urgent\' THEN 1 WHEN \'high\' THEN 2 WHEN \'normal\' THEN 3 ELSE 4 END,t.due_date NULLS LAST LIMIT 300');res.json({data:r.rows});}catch(e){next(e);}});
  router.post('/tasks',async(req,res,next)=>{const p=taskSchema.safeParse(req.body);if(!p.success)return fail(res,p);const v=p.data;try{const r=await pool.query('INSERT INTO tasks(title,description,due_date,priority,status,case_id,assigned_to) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,title,description,due_date AS "dueDate",priority,status,case_id AS "caseId",assigned_to AS "assignedTo"',[v.title,v.description||null,v.dueDate||null,v.priority,v.status,v.caseId||null,v.assignedTo||null]);res.status(201).json({data:r.rows[0]});}catch(e){next(e);}});
  router.patch('/tasks/:id/status',async(req,res,next)=>{const p=z.object({status:z.enum(['open','in_progress','done','cancelled'])}).safeParse(req.body);if(!p.success)return fail(res,p);try{const r=await pool.query('UPDATE tasks SET status=$1 WHERE id=$2 RETURNING id,status',[p.data.status,req.params.id]);if(!r.rowCount)return res.status(404).json({error:'Attività non trovata'});res.json({data:r.rows[0]});}catch(e){next(e);}});

  router.get('/invoices',async(_req,res,next)=>{try{const r=await pool.query('SELECT i.id,i.invoice_number AS "invoiceNumber",i.case_id AS "caseId",i.customer_id AS "customerId",i.issue_date AS "issueDate",i.due_date AS "dueDate",i.amount,i.status,i.notes,COALESCE(SUM(p.amount),0)::numeric(10,2) AS "paidAmount" FROM invoices i LEFT JOIN payments p ON p.invoice_id=i.id GROUP BY i.id ORDER BY i.issue_date DESC LIMIT 300');res.json({data:r.rows});}catch(e){next(e);}});
  router.post('/invoices',async(req,res,next)=>{const p=invoiceSchema.safeParse(req.body);if(!p.success)return fail(res,p);const v=p.data;try{const r=await pool.query('INSERT INTO invoices(invoice_number,case_id,customer_id,issue_date,due_date,amount,status,notes) VALUES($1,$2,$3,COALESCE($4::date,CURRENT_DATE),$5,$6,$7,$8) RETURNING id,invoice_number AS "invoiceNumber",amount,status',[v.invoiceNumber,v.caseId||null,v.customerId||null,v.issueDate||null,v.dueDate||null,v.amount,v.status,v.notes||null]);res.status(201).json({data:r.rows[0]});}catch(e){if(e.code==='23505')return res.status(409).json({error:'Numero documento già utilizzato.'});next(e);}});
  router.post('/invoices/:id/payments',async(req,res,next)=>{const p=paymentSchema.safeParse(req.body);if(!p.success)return fail(res,p);const v=p.data;const client=await pool.connect();try{await client.query('BEGIN');const inv=await client.query('SELECT id,amount,status FROM invoices WHERE id=$1 FOR UPDATE',[req.params.id]);if(!inv.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Documento non trovato'});}if(['draft','cancelled'].includes(inv.rows[0].status)){await client.query('ROLLBACK');return res.status(409).json({error:'Il documento non può ricevere pagamenti nello stato attuale'});}const paid=await client.query('SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE invoice_id=$1',[req.params.id]);const remaining=Number(inv.rows[0].amount)-Number(paid.rows[0].total);if(v.amount>remaining+0.001){await client.query('ROLLBACK');return res.status(409).json({error:'Il pagamento supera il residuo da incassare'});}const payment=await client.query('INSERT INTO payments(invoice_id,amount,payment_date,method,reference) VALUES($1,$2,COALESCE($3::date,CURRENT_DATE),$4,$5) RETURNING id,amount,payment_date AS "paymentDate",method,reference',[req.params.id,v.amount,v.paymentDate||null,v.method,v.reference||null]);const total=Number(paid.rows[0].total)+v.amount;const status=total>=Number(inv.rows[0].amount)?'paid':'partial';await client.query('UPDATE invoices SET status=$1 WHERE id=$2',[status,req.params.id]);await client.query('COMMIT');res.status(201).json({data:payment.rows[0],paidAmount:total,remainingEuro:Number(inv.rows[0].amount)-total,status});}catch(e){await client.query('ROLLBACK');next(e);}finally{client.release();}});

  return router;
};
