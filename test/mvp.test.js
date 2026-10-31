import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

test('RAFID pilot: real HTTP, persistent database and complete role workflows',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'rafid-mvp-'));
 const dbPath=join(directory,'test.sqlite'),port=32000+Math.floor(Math.random()*10000),base=`http://127.0.0.1:${port}`;
 let server,output='';
 async function start(){server=spawn(process.execPath,['server.js'],{cwd:process.cwd(),env:{...process.env,DEMO_MODE:'1',DB_PATH:dbPath,PORT:String(port),HOST:'127.0.0.1'}});server.stdout.on('data',b=>output+=b);server.stderr.on('data',b=>output+=b);await new Promise((resolve,reject)=>{const until=Date.now()+12000;const timer=setInterval(()=>{if(output.includes('RAFID listening')){clearInterval(timer);resolve();}else if(server.exitCode!==null||Date.now()>until){clearInterval(timer);reject(new Error(output));}},40);});}
 async function stop(){if(server.exitCode===null){const done=new Promise(r=>server.once('exit',r));server.kill();await done;}}
 async function request(path,{body,cookie,headers={},status=200}={}){const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});let data;try{data=await response.json();}catch{data={};}assert.equal(response.status,status,`${path}: ${JSON.stringify(data)}`);return {data,response};}
 async function login(account){const {response,data}=await request('/api/login',{body:{email:account+'@rafid.local',password:'RafidDemo2026!'}});return {cookie:response.headers.get('set-cookie').split(';')[0],user:data};}
 let merchant,supplier,supplier2,admin,driver,platform,outsider,orderId,first,second;
 const action=(actor,id,name,note='',status=200)=>request(`/api/suborders/${id}/action`,{cookie:actor.cookie,body:{action:name,note},status});
 async function quote(actor,items){return (await request('/api/quotes',{cookie:actor.cookie,body:{zone:'دمشق',address:'عنوان اختبار غير حقيقي — متجر التجربة',items}})).data;}
 async function order(actor,q,key=crypto.randomUUID(),status=200){return (await request('/api/orders',{cookie:actor.cookie,body:{quote_id:q.id},headers:{'Idempotency-Key':key},status})).data;}
 await start();
 try{
 await t.test('public health, authentication, origin protection and no static data exposure',async()=>{
  await request('/api/health');await request('/api/orders',{status:401});await request('/data/rafid.sqlite',{status:404});
  await request('/api/login',{body:{email:'admin@rafid.local',password:'wrong'},status:401});
  await request('/api/login',{body:{email:'admin@rafid.local',password:'RafidDemo2026!'},headers:{Origin:'https://attacker.invalid'},status:403});
  [merchant,supplier,supplier2,admin,driver,platform]=await Promise.all(['merchant','supplier','supplier2','admin','driver','platform'].map(login));
  const r=await request('/api/me',{cookie:merchant.cookie});assert.equal(r.data.role,'merchant');assert.ok(!('password' in r.data));
  assert.ok(r.response.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
 });
 await t.test('merchant registration and private offer isolation',async()=>{
  await request('/api/register',{body:{name:'محل اختبار ثانٍ',email:'other@rafid.local',password:'TestMerchant2026!'}});
  const l=await request('/api/login',{body:{email:'other@rafid.local',password:'TestMerchant2026!'}});outsider={cookie:l.response.headers.get('set-cookie').split(';')[0]};
  const a=(await request('/api/catalog',{cookie:merchant.cookie})).data,b=(await request('/api/catalog',{cookie:outsider.cookie})).data;
  assert.equal(a.find(x=>x.id===1).price,75000);assert.equal(b.find(x=>x.id===1).price,85000);assert.equal(b.find(x=>x.id===1).offer_id,null);
  await request('/api/products',{cookie:merchant.cookie,body:{},status:403});
  await request('/api/register',{body:{name:'x',email:'other@rafid.local',password:'TestMerchant2026!'},status:409});
 });
 await t.test('catalog identity, inventory, minimums and zone validation',async()=>{
  const catalog=(await request('/api/catalog',{cookie:merchant.cookie})).data;assert.equal(catalog.length,12);assert.equal(new Set(catalog.map(x=>x.product_id)).size,6);
  await request('/api/quotes',{cookie:merchant.cookie,body:{zone:'خارج الخدمة',address:'اختبار',items:[{listing_id:1,quantity:1}]},status:422});
  await request('/api/quotes',{cookie:merchant.cookie,body:{zone:'دمشق',address:'اختبار',items:[{listing_id:1,quantity:999}]},status:422});
  await request('/api/quotes',{cookie:merchant.cookie,body:{zone:'دمشق',address:'اختبار',items:[{listing_id:1,quantity:1},{listing_id:1,quantity:1}]},status:422});
  await request('/api/products',{cookie:admin.cookie,body:{name:'أرز بسمتي',brand:'الوليمة',pack:'كيس 5 كغ',category:'حبوب',weight:5},status:409});
 });
 await t.test('multi-supplier checkout is atomic, priced and idempotent',async()=>{
  const q=await quote(merchant,[{listing_id:1,quantity:2},{listing_id:4,quantity:1}]);assert.equal(q.groups.length,2);assert.equal(q.total,345000);
  const key=crypto.randomUUID(),o=await order(merchant,q,key);orderId=o.id;assert.equal((await order(merchant,q,key)).id,orderId);
  const other=await quote(merchant,[{listing_id:1,quantity:1}]);await order(merchant,other,key,409);
  const os=(await request('/api/orders',{cookie:merchant.cookie})).data;assert.equal(os.length,1);assert.equal(os[0].suborders.length,2);[first,second]=os[0].suborders;
  assert.equal((await request('/api/catalog',{cookie:merchant.cookie})).data.find(l=>l.id===1).stock,48);
 });
 await t.test('cross-supplier, cross-merchant and driver access are blocked',async()=>{
  await action(supplier2,first.id,'confirm','',404);await action(outsider,first.id,'cancel','test',404);await action(driver,first.id,'pickup','',404);
  assert.equal((await request('/api/orders',{cookie:supplier.cookie})).data.length,1);assert.equal((await request('/api/orders',{cookie:driver.cookie})).data.length,0);
 });
 await t.test('supplier acceptance, rejection and stock release are independent',async()=>{
  await action(supplier,first.id,'confirm');await action(supplier2,second.id,'reject','نفاد تشغيلي');await action(supplier2,second.id,'reject','مرة ثانية',422);
  assert.equal((await request('/api/catalog',{cookie:merchant.cookie})).data.find(l=>l.id===4).stock,50);
  await action(supplier,first.id,'prepare');await action(supplier,first.id,'ready');
  await action(merchant,first.id,'cancel','متأخر',422);
 });
 await t.test('dispatch validates ownership, zone, capacity and duplicate assignment',async()=>{
  await request('/api/dispatch',{cookie:supplier.cookie,body:{driver_id:6,suborder_ids:[first.id]},status:403});
  await request('/api/dispatch',{cookie:admin.cookie,body:{driver_id:6,suborder_ids:[first.id]},status:422});
  await request('/api/dispatch',{cookie:supplier.cookie,body:{driver_id:5,suborder_ids:[first.id]}});
  await request('/api/dispatch',{cookie:supplier.cookie,body:{driver_id:5,suborder_ids:[first.id]},status:409});
 });
 await t.test('delivery code is merchant-only; transitions and collection stay controlled',async()=>{
  await action(driver,first.id,'arrive','',409);await action(driver,first.id,'accept');await action(driver,first.id,'pickup');
  const mine=(await request('/api/orders',{cookie:merchant.cookie})).data[0].suborders.find(s=>s.id===first.id);assert.match(mine.deliveryCode,/^\d{6}$/);
  const theirs=(await request('/api/orders',{cookie:driver.cookie})).data[0];assert.equal(theirs.deliveryCode,undefined);assert.equal(theirs.proof,undefined);
  await action(driver,first.id,'depart');await action(driver,first.id,'arrive');
  await request(`/api/suborders/${first.id}/deliver`,{cookie:driver.cookie,body:{code:'wrong',collection:0},status:422});
  await request(`/api/suborders/${first.id}/deliver`,{cookie:driver.cookie,body:{code:mine.deliveryCode,collection:999999},status:422});
  await request(`/api/suborders/${first.id}/deliver`,{cookie:driver.cookie,body:{code:mine.deliveryCode,collection:first.total}});
  await request(`/api/suborders/${first.id}/deliver`,{cookie:driver.cookie,body:{code:mine.deliveryCode,collection:0},status:422});
 });
 await t.test('complaints, resolution, ratings and non-duplicated reporting',async()=>{
  await request('/api/ratings',{cookie:merchant.cookie,body:{suborder_id:first.id,score:5}});await request('/api/ratings',{cookie:merchant.cookie,body:{suborder_id:first.id,score:4},status:409});
  await request('/api/complaints',{cookie:merchant.cookie,body:{suborder_id:first.id,message:'نقص في عبوة من بند الطلب — تجربة'}});
  const s=(await request('/api/orders',{cookie:admin.cookie})).data.find(s=>s.id===first.id);assert.equal(s.status,'delivered');assert.equal(s.complaints.length,1);
  await request('/api/complaints/'+s.complaints[0].id,{cookie:admin.cookie,body:{resolution:'تم الاتفاق مع المورد على استكمال النقص'}});
  const r=(await request('/api/report',{cookie:admin.cookie})).data;assert.equal(r.completed,1);assert.equal(r.gmv,150000);assert.equal(r.collections,165000);assert.ok(r.audit.length>0);
 });
 await t.test('price changes require new consent before checkout',async()=>{
  const q=await quote(merchant,[{listing_id:3,quantity:1}]);
  await request('/api/listings',{cookie:supplier.cookie,body:{product_id:2,price:175000,stock:50,min_qty:1}});await order(merchant,q,crypto.randomUUID(),409);
 });
 await t.test('last-unit concurrency cannot oversell and cancellation releases once',async()=>{
  await request('/api/listings',{cookie:supplier.cookie,body:{product_id:6,price:180000,stock:1,min_qty:1}});
  const q1=await quote(merchant,[{listing_id:11,quantity:1}]),q2=await quote(outsider,[{listing_id:11,quantity:1}]);
  const result=await Promise.all([fetch(base+'/api/orders',{method:'POST',headers:{'Content-Type':'application/json',Cookie:merchant.cookie,'Idempotency-Key':'last-a'},body:JSON.stringify({quote_id:q1.id})}),fetch(base+'/api/orders',{method:'POST',headers:{'Content-Type':'application/json',Cookie:outsider.cookie,'Idempotency-Key':'last-b'},body:JSON.stringify({quote_id:q2.id})})]);
  assert.equal(result.filter(r=>r.status===200).length,1);assert.equal(result.filter(r=>r.status>=400).length,1);
  const winner=result[0].status===200?merchant:outsider;const o=(await request('/api/orders',{cookie:winner.cookie})).data.find(o=>o.suborders.some(s=>s.items.some(i=>i.product_id===6)));const sub=o.suborders[0];await action(winner,sub.id,'cancel','اختبار تحرير المخزون');await action(winner,sub.id,'cancel','مكرر',422);
  assert.equal((await request('/api/catalog',{cookie:merchant.cookie})).data.find(l=>l.id===11).stock,1);
 });
 await t.test('platform multi-order trip, failure isolation and retry',async()=>{
  const q=await quote(merchant,[{listing_id:5,quantity:1},{listing_id:6,quantity:1}]);const o=await order(merchant,q);const subs=(await request('/api/orders',{cookie:merchant.cookie})).data.find(x=>x.id===o.id).suborders;
  for(const s of subs){const owner=s.supplier_id===1?supplier:supplier2;await action(owner,s.id,'confirm');await action(owner,s.id,'prepare');await action(owner,s.id,'ready');await action(owner,s.id,'platform');}
  await request('/api/dispatch',{cookie:admin.cookie,body:{driver_id:6,suborder_ids:subs.map(s=>s.id)}});
  for(const s of subs){await action(platform,s.id,'accept');await action(platform,s.id,'pickup');}
  await action(platform,subs[0].id,'fail','المحل مغلق');await action(platform,subs[1].id,'depart');await action(platform,subs[1].id,'arrive');
  const my=(await request('/api/orders',{cookie:merchant.cookie})).data.find(x=>x.id===o.id).suborders;
  const delivered=my.find(s=>s.id===subs[1].id);await request(`/api/suborders/${delivered.id}/deliver`,{cookie:platform.cookie,body:{code:delivered.deliveryCode,collection:0}});
  await action(admin,subs[0].id,'retry','عادت الحمولة كاملة إلى المورد وتمت مراجعتها');
  const statuses=(await request('/api/orders',{cookie:merchant.cookie})).data.find(x=>x.id===o.id).suborders.map(s=>s.status);assert.deepEqual(statuses,['ready','delivered']);
 });
 await t.test('capacity checks, private offers and expiry are enforced in database transactions',async()=>{
  await request('/api/drivers',{cookie:supplier.cookie,body:{name:'سائق تجريبي صغير',email:'small@rafid.local',password:'SmallDriver2026!',zone:'دمشق',capacity:1,max_orders:1}});
  const ds=(await request('/api/drivers',{cookie:supplier.cookie})).data;const small=ds.find(d=>d.email==='small@rafid.local');
  const q=await quote(merchant,[{listing_id:1,quantity:1}]);const o=await order(merchant,q);let sub=(await request('/api/orders',{cookie:merchant.cookie})).data.find(x=>x.id===o.id).suborders[0];
  await action(supplier,sub.id,'confirm');await action(supplier,sub.id,'prepare');await action(supplier,sub.id,'ready');await request('/api/dispatch',{cookie:supplier.cookie,body:{driver_id:small.user_id,suborder_ids:[sub.id]},status:422});
  const pending=await order(merchant,await quote(merchant,[{listing_id:1,quantity:1}]));const raw=new DatabaseSync(dbPath);raw.prepare('UPDATE suborders SET expires=0 WHERE order_id=?').run(pending.id);raw.close();
  const expired=(await request('/api/orders',{cookie:merchant.cookie})).data.find(o=>o.id===pending.id);assert.equal(expired.suborders[0].status,'expired');
 });
 await t.test('recommendations include delivery fees, schedules and receipt acknowledgement',async()=>{
  const input={zone:'دمشق',address:'اختبار الخطة',items:[{listing_id:2,quantity:2},{listing_id:3,quantity:1}]};
  const plan=(await request('/api/recommendations',{cookie:merchant.cookie,body:input})).data;
  assert.ok(plan.total<=plan.reference_total);assert.equal(plan.reference_total-plan.total,plan.saving);assert.ok(plan.examined>0);assert.equal(plan.items.reduce((s,i)=>s+i.quantity,0),3);
  await action(merchant,first.id,'receipt');await action(merchant,first.id,'receipt','',422);
  const address=(await request('/api/address',{cookie:merchant.cookie})).data;assert.ok(address.address.includes('اختبار'));
  await request('/api/store',{cookie:supplier.cookie,body:{zone:'دمشق',fee:15000,minimum:50000,delivery:'09:00–13:00',weekdays:'0,1,2,3,4,5,6',cutoff_hour:18,daily_capacity:1}});
  const q=await quote(merchant,[{listing_id:1,quantity:1}]);const o=await order(merchant,q);const q2=await quote(merchant,[{listing_id:1,quantity:1}]);assert.notEqual(q.groups[0].delivery_date,q2.groups[0].delivery_date);
  const sub=(await request('/api/orders',{cookie:merchant.cookie})).data.find(x=>x.id===o.id).suborders[0];await action(merchant,sub.id,'cancel','اختبار الموعد');
 });
 await t.test('public offer redemption limits stay atomic and cancellation restores availability',async()=>{
  const b={listing_id:3,price:50000,merchant_id:null,starts:new Date(Date.now()-60000).toISOString(),ends:new Date(Date.now()+3600000).toISOString(),max_uses:1};
  await request('/api/offers',{cookie:supplier.cookie,body:{...b,merchant_id:1},status:422});
  await request('/api/offers',{cookie:supplier.cookie,body:b});
  const q1=await quote(merchant,[{listing_id:3,quantity:1}]),q2=await quote(outsider,[{listing_id:3,quantity:1}]);
  const rows=await Promise.all([fetch(base+'/api/orders',{method:'POST',headers:{'Content-Type':'application/json',Cookie:merchant.cookie,'Idempotency-Key':'offer-limit-a'},body:JSON.stringify({quote_id:q1.id})}),fetch(base+'/api/orders',{method:'POST',headers:{'Content-Type':'application/json',Cookie:outsider.cookie,'Idempotency-Key':'offer-limit-b'},body:JSON.stringify({quote_id:q2.id})})]);
  assert.equal(rows.filter(r=>r.status===200).length,1);assert.equal(rows.filter(r=>r.status>=400).length,1);
  const index=rows[0].status===200?0:1,winner=index===0?merchant:outsider,created=await rows[index].json();
  const sub=(await request('/api/orders',{cookie:winner.cookie})).data.find(o=>o.id===created.id).suborders[0];await action(winner,sub.id,'cancel','اختبار إعادة صلاحية العرض');
  assert.equal((await request('/api/catalog',{cookie:outsider.cookie})).data.find(l=>l.id===3).price,50000);
 });
 await t.test('live backup restores a consistent database and production refuses demo data',async()=>{
  const destination=join(directory,'backup.sqlite');
  const result=spawnSync(process.execPath,['scripts/backup.js',dbPath,destination],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  const original=new DatabaseSync(dbPath,{readOnly:true}),restored=new DatabaseSync(destination,{readOnly:true});
  try{assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(restored.prepare('SELECT count(*) n FROM orders').get().n,original.prepare('SELECT count(*) n FROM orders').get().n);assert.equal(restored.prepare('SELECT sum(total) n FROM orders').get().n,original.prepare('SELECT sum(total) n FROM orders').get().n);}finally{original.close();restored.close();}
  const bad=spawnSync(process.execPath,['server.js'],{env:{...process.env,DB_PATH:destination,DEMO_MODE:'0',PORT:String(port+1)},encoding:'utf8',timeout:5000});assert.notEqual(bad.status,0);assert.match(bad.stderr,/Demo database detected/);
 });
 await t.test('fresh pilot boot has only an administrator and no demo credentials',async()=>{
  const productionPath=join(directory,'pilot.sqlite');
  const bad=spawnSync(process.execPath,['server.js'],{env:{...process.env,DB_PATH:productionPath,DEMO_MODE:'0',ADMIN_PASSWORD:'short'},encoding:'utf8',timeout:5000});assert.notEqual(bad.status,0);assert.match(bad.stderr,/ADMIN_PASSWORD/);
  const prod=spawn(process.execPath,['server.js'],{env:{...process.env,DB_PATH:productionPath,DEMO_MODE:'0',ADMIN_PASSWORD:'UniquePilotPassword2026!',PORT:String(port+1),HOST:'127.0.0.1'}});
  try{await new Promise((resolve,reject)=>{let s='';const timer=setTimeout(()=>reject(new Error(s)),6000);prod.stdout.on('data',b=>{s+=b;if(s.includes('RAFID listening')){clearTimeout(timer);resolve();}});prod.once('error',reject);});const r=await fetch(`http://127.0.0.1:${port+1}/api/config`);assert.equal((await r.json()).demo,false);const clean=new DatabaseSync(productionPath,{readOnly:true});try{assert.equal(clean.prepare('SELECT count(*) n FROM users').get().n,1);assert.equal(clean.prepare('SELECT count(*) n FROM suppliers').get().n,0);}finally{clean.close();}}finally{const done=new Promise(r=>prod.once('exit',r));prod.kill();await done;}
 });
 await t.test('data and sessions survive process restart; logout revokes access',async()=>{
  await stop();output='';await start();const os=(await request('/api/orders',{cookie:merchant.cookie})).data;assert.ok(os.some(o=>o.id===orderId));
  await request('/api/logout',{cookie:merchant.cookie,body:{}});await request('/api/me',{cookie:merchant.cookie,status:401});
 });
 }finally{await stop();rmSync(directory,{recursive:true,force:true});}
});
