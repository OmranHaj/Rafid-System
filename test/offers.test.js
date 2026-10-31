import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';

test('Offer engine: eligibility, pricing, visibility and transactional limits',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'rafid-offers-')),path=join(dir,'db.sqlite'),port=42000+Math.floor(Math.random()*9000),base=`http://127.0.0.1:${port}`;
 const server=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DB_PATH:path,DEMO_MODE:'1'}});
 let logs='';server.stderr.on('data',b=>logs+=b);
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(logs)),8000);server.stdout.on('data',b=>{if(String(b).includes('RAFID listening')){clearTimeout(timer);resolve();}});});
 const db=new DatabaseSync(path);
 async function call(route,actor,body,status=200,headers={}){const r=await fetch(base+'/api'+route,{method:body===undefined?'GET':'POST',headers:{...(actor?{Cookie:actor}:{}),...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();assert.equal(r.status,status,route+': '+JSON.stringify(data));return {data,response:r};}
 async function login(account){return (await call('/login',null,{email:account+'@rafid.local',password:'RafidDemo2026!'})).response.headers.get('set-cookie').split(';')[0];}
 const [merchant,supplier,supplier2,admin]=await Promise.all(['merchant','supplier','supplier2','admin'].map(login));
 await call('/register',null,{name:'محل اختبار العروض',email:'offers-other@rafid.local',password:'OffersMerchant2026!'});
 const otherLogin=await call('/login',null,{email:'offers-other@rafid.local',password:'OffersMerchant2026!'}),other=otherLogin.response.headers.get('set-cookie').split(';')[0];
 const otherId=otherLogin.data.id;
 const defaults={listing_id:3,title:'عرض اختباري',terms:'نفس العبوة دون استبدال',discount_type:'fixed',discount_value:100000,starts:new Date(Date.now()-60000).toISOString(),ends:new Date(Date.now()+86400000).toISOString(),max_uses:100,min_qty:1,audience:'all'};
 const offer=async b=>(await call('/offers',supplier,{...defaults,...b})).data.id;
 const listing=async(actor,id=3)=>(await call('/catalog',actor)).data.find(l=>l.id===id);
 const reset=()=>db.prepare('UPDATE offers SET active=0').run();
 async function quote(actor,quantity=1,listing_id=3,zone='دمشق'){return (await call('/quotes',actor,{zone,address:'عنوان اختبار فقط',items:[{listing_id,quantity}]})).data;}
 async function order(actor,q,status=200){return (await call('/orders',actor,{quote_id:q.id},status,{'Idempotency-Key':crypto.randomUUID()})).data;}
 async function cancel(actor,id){const s=(await call('/orders',actor)).data.find(o=>o.id===id).suborders[0];await call('/suborders/'+s.id+'/action',actor,{action:'cancel',note:'إلغاء تجريبي'});}
 try{
  await t.test('quantity threshold changes quote price without advertising an unconditional discount',async()=>{
   reset();const id=await offer({discount_type:'percent',discount_value:20,min_qty:3});
   const l=await listing(merchant);assert.equal(l.offer_id,null);assert.equal(l.price,165000);assert.equal(l.promotions[0].min_qty,3);
   assert.equal((await quote(merchant,2)).groups[0].items[0].price,165000);const q=await quote(merchant,3);assert.equal(q.groups[0].items[0].price,132000);assert.equal(q.groups[0].items[0].offer_id,id);
  });
  await t.test('best eligible discount wins without stacking; absolute discounts track base prices',async()=>{
   reset();await offer({discount_type:'percent',discount_value:10});await offer({discount_type:'amount',discount_value:20000});
   assert.equal((await listing(merchant)).price,145000);const fixed=await offer({discount_value:140000});assert.equal((await listing(merchant)).offer_id,fixed);
   await call('/listings',supplier,{product_id:2,price:200000,stock:50,min_qty:1});assert.equal((await listing(merchant)).price,140000);
   await call('/listings',supplier,{product_id:2,price:165000,stock:50,min_qty:1});
  });
  await t.test('group membership is supplier-scoped and never exposed to another merchant',async()=>{
   reset();const old=await order(merchant,await quote(merchant));await cancel(merchant,old.id);
   const group=(await call('/offer-groups',supplier,{name:'عملاء الاختبار',merchant_ids:[2]})).data.id;
   await call('/offer-groups',supplier2,{name:'محاولة كشف عميل',merchant_ids:[otherId]},422);
   const id=await offer({audience:'group',group_id:group});assert.equal((await listing(merchant)).offer_id,id);const hidden=await listing(other);assert.equal(hidden.offer_id,null);assert.equal(hidden.promotions.length,0);
   await call('/offers',supplier2,{...defaults,listing_id:4,audience:'group',group_id:group},404);
   const detail=(await listing(merchant)).promotions[0];assert.equal(detail.group_id,undefined);assert.equal(detail.merchant_ids,undefined);
  });
  await t.test('zone and first-order eligibility are checked for the actual quote context',async()=>{
   reset();const zone=await offer({audience:'zone',target_zone:'دمشق'});assert.equal((await listing(other)).offer_id,null);assert.equal((await quote(other)).groups[0].items[0].offer_id,zone);
   reset();const first=await offer({audience:'first_order'});assert.equal((await listing(other)).offer_id,first);
   const placed=await order(other,await quote(other));assert.equal((await listing(other)).offer_id,null);await cancel(other,placed.id);assert.equal((await listing(other)).offer_id,first);
  });
  await t.test('reactivation requires an old delivered order and excludes new and active customers',async()=>{
   reset();const placed=await order(merchant,await quote(merchant));const sub=db.prepare('SELECT id FROM suborders WHERE order_id=?').get(placed.id);
   db.prepare("UPDATE suborders SET status='delivered' WHERE id=?").run(sub.id);db.prepare('UPDATE orders SET created=? WHERE id=?').run(new Date(Date.now()-45*86400000).toISOString(),placed.id);
   const id=await offer({audience:'reactivation',inactivity_days:30});assert.equal((await listing(merchant)).offer_id,id);assert.equal((await listing(other)).offer_id,null);
   const active=await order(merchant,await quote(merchant));assert.equal((await listing(merchant)).offer_id,null);await cancel(merchant,active.id);
   db.prepare('UPDATE orders SET created=? WHERE id=?').run(new Date().toISOString(),placed.id);assert.equal((await listing(merchant)).offer_id,null);
  });
  await t.test('quantity budgets are atomic under concurrent checkout and restored once on cancellation',async()=>{
   reset();const id=await offer({max_quantity:3});const a=await quote(merchant,2),b=await quote(other,2);
   async function submit(actor,q){const r=await fetch(base+'/api/orders',{method:'POST',headers:{'Content-Type':'application/json',Cookie:actor,'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({quote_id:q.id})});return {status:r.status,data:await r.json(),actor};}
   const results=await Promise.all([submit(merchant,a),submit(other,b)]);assert.equal(results.filter(r=>r.status===200).length,1);assert.equal(results.filter(r=>r.status===409).length,1);
   assert.equal(db.prepare('SELECT used_quantity FROM offers WHERE id=?').get(id).used_quantity,2);
   const winner=results.find(r=>r.status===200);await cancel(winner.actor,winner.data.id);assert.equal(db.prepare('SELECT used_quantity FROM offers WHERE id=?').get(id).used_quantity,0);
  });
  await t.test('per-merchant limits, ownership, scheduled and expired offers are enforced',async()=>{
   reset();const id=await offer({per_merchant_limit:1});const placed=await order(merchant,await quote(merchant));assert.equal((await listing(merchant)).offer_id,null);assert.equal((await listing(other)).offer_id,id);await cancel(merchant,placed.id);
   await call('/offers/'+id,supplier2,{...defaults},404);await call('/offers/'+id,merchant,{...defaults},403);
   reset();await offer({starts:new Date(Date.now()+3600000).toISOString(),ends:new Date(Date.now()+7200000).toISOString()});assert.equal((await listing(merchant)).offer_id,null);
   const active=await offer({});db.prepare('UPDATE offers SET ends=? WHERE id=?').run(new Date(Date.now()-1000).toISOString(),active);assert.equal((await listing(merchant)).offer_id,null);
  });
  await t.test('editing invalidates stale consent, pauses new use and preserves ordered terms',async()=>{
   reset();const id=await offer({title:'شروط قبل التعديل'}),q=await quote(merchant);const placed=await order(merchant,q);
   const o=(await call('/offers',supplier)).data.find(o=>o.id===id);await call('/offers/'+id,supplier,{...o,terms:'شروط جديدة',active:false});
   assert.equal((await listing(merchant)).offer_id,null);await order(merchant,await quote(merchant));
   const saved=(await call('/orders',merchant)).data.find(o=>o.id===placed.id).suborders[0].items[0];assert.equal(saved.offer_title,'شروط قبل التعديل');assert.equal(saved.offer_terms,defaults.terms);
   await call('/offers/'+id,supplier,{...o,terms:'شروط جديدة',active:true});await order(merchant,q,409);
   await call('/offers/'+id,supplier,{...o,max_quantity:0},422);
   await call('/offers',supplier,{...defaults,discount_type:'percent',discount_value:100},422);
  });
 }finally{db.close();const done=new Promise(r=>server.once('exit',r));server.kill();await done;rmSync(dir,{recursive:true,force:true});}
});
