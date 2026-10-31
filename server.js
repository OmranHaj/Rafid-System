import http from 'node:http';
import {createOfferEngine} from './offers.js';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const demo = process.env.DEMO_MODE === '1';
const dbPath = resolve(process.env.DB_PATH || './data/rafid.sqlite');
mkdirSync(dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,password TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','supplier','merchant','driver')),supplier_id INTEGER,active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS suppliers(id INTEGER PRIMARY KEY,name TEXT NOT NULL,zone TEXT NOT NULL,fee INTEGER NOT NULL CHECK(fee>=0),minimum INTEGER NOT NULL CHECK(minimum>=0),active INTEGER NOT NULL DEFAULT 0,delivery TEXT NOT NULL DEFAULT 'غدًا 09:00–14:00');
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY,name TEXT NOT NULL,brand TEXT NOT NULL,pack TEXT NOT NULL,category TEXT NOT NULL,weight REAL NOT NULL DEFAULT 0,CHECK(weight>=0));
CREATE TABLE IF NOT EXISTS listings(id INTEGER PRIMARY KEY,supplier_id INTEGER NOT NULL REFERENCES suppliers(id),product_id INTEGER NOT NULL REFERENCES products(id),price INTEGER NOT NULL CHECK(price>0),stock INTEGER NOT NULL CHECK(stock>=0),min_qty INTEGER NOT NULL DEFAULT 1 CHECK(min_qty>0),updated TEXT NOT NULL,UNIQUE(supplier_id,product_id));
CREATE TABLE IF NOT EXISTS offers(id INTEGER PRIMARY KEY,listing_id INTEGER NOT NULL REFERENCES listings(id),price INTEGER NOT NULL CHECK(price>0),merchant_id INTEGER REFERENCES users(id),starts TEXT NOT NULL,ends TEXT NOT NULL,max_uses INTEGER NOT NULL DEFAULT 100 CHECK(max_uses>0),uses INTEGER NOT NULL DEFAULT 0 CHECK(uses>=0));
CREATE TABLE IF NOT EXISTS drivers(user_id INTEGER PRIMARY KEY REFERENCES users(id),supplier_id INTEGER REFERENCES suppliers(id),zone TEXT NOT NULL,capacity REAL NOT NULL CHECK(capacity>0),max_orders INTEGER NOT NULL DEFAULT 5 CHECK(max_orders>0),available INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS quotes(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),payload TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY,merchant_id INTEGER NOT NULL REFERENCES users(id),address TEXT NOT NULL,zone TEXT NOT NULL,total INTEGER NOT NULL,created TEXT NOT NULL,idempotency TEXT NOT NULL,fingerprint TEXT NOT NULL,UNIQUE(merchant_id,idempotency));
CREATE TABLE IF NOT EXISTS suborders(id INTEGER PRIMARY KEY,order_id INTEGER NOT NULL REFERENCES orders(id),supplier_id INTEGER NOT NULL REFERENCES suppliers(id),status TEXT NOT NULL,total INTEGER NOT NULL,fee INTEGER NOT NULL,delivery TEXT NOT NULL,method TEXT NOT NULL DEFAULT 'supplier',trip_id INTEGER,proof TEXT,proof_attempts INTEGER NOT NULL DEFAULT 0,proof_expires INTEGER,collection INTEGER NOT NULL DEFAULT 0,expires INTEGER NOT NULL,UNIQUE(order_id,supplier_id));
CREATE TABLE IF NOT EXISTS order_items(id INTEGER PRIMARY KEY,suborder_id INTEGER NOT NULL REFERENCES suborders(id),listing_id INTEGER NOT NULL REFERENCES listings(id),product_id INTEGER NOT NULL REFERENCES products(id),name TEXT NOT NULL,pack TEXT NOT NULL,quantity INTEGER NOT NULL CHECK(quantity>0),price INTEGER NOT NULL,weight REAL NOT NULL,offer_id INTEGER REFERENCES offers(id));
CREATE TABLE IF NOT EXISTS trips(id INTEGER PRIMARY KEY,driver_id INTEGER NOT NULL REFERENCES users(id),created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,suborder_id INTEGER NOT NULL REFERENCES suborders(id),actor_id INTEGER NOT NULL REFERENCES users(id),action TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS complaints(id INTEGER PRIMARY KEY,suborder_id INTEGER NOT NULL REFERENCES suborders(id),merchant_id INTEGER NOT NULL REFERENCES users(id),message TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',resolution TEXT NOT NULL DEFAULT '',created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ratings(id INTEGER PRIMARY KEY,suborder_id INTEGER NOT NULL UNIQUE REFERENCES suborders(id),merchant_id INTEGER NOT NULL REFERENCES users(id),score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5));
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,actor_id INTEGER NOT NULL REFERENCES users(id),action TEXT NOT NULL,entity TEXT NOT NULL,created TEXT NOT NULL);
PRAGMA user_version=1;`);

const sql = (s, ...args) => db.prepare(s).run(...args);
const one = (s, ...args) => db.prepare(s).get(...args);
const all = (s, ...args) => db.prepare(s).all(...args);
// Additive schema upgrades preserve databases created by earlier pilot commits.
for (const [table,column,definition] of [
  ['suppliers','weekdays',"TEXT NOT NULL DEFAULT '0,1,2,3,4,5,6'"],
  ['suppliers','cutoff_hour','INTEGER NOT NULL DEFAULT 18'],
  ['suppliers','daily_capacity','INTEGER NOT NULL DEFAULT 20'],
  ['suborders','delivery_date',"TEXT NOT NULL DEFAULT ''"],
  ['suborders','collection_confirmed','INTEGER NOT NULL DEFAULT 0']
]) if(!all(`PRAGMA table_info(${table})`).some(c=>c.name===column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
db.exec('CREATE TABLE IF NOT EXISTS addresses(user_id INTEGER PRIMARY KEY REFERENCES users(id),zone TEXT NOT NULL,address TEXT NOT NULL); PRAGMA user_version=2;');
const now = () => new Date().toISOString();
const token = () => randomBytes(24).toString('hex');
const hash = s => createHash('sha256').update(s).digest('hex');
function password(s, salt = randomBytes(16).toString('hex')) { return `${salt}:${scryptSync(s, salt, 64).toString('hex')}`; }
function verify(s, stored) { const [salt, value] = stored.split(':'); const candidate = scryptSync(s, salt, 64); return timingSafeEqual(candidate, Buffer.from(value, 'hex')); }
function fail(status, message) { const e = new Error(message); e.status = status; throw e; }
function need(test, message, status = 422) { if (!test) fail(status, message); }
function str(value, label, max = 200) { need(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max, `${label} مطلوب وبحد أقصى ${max} حرف`); return value.trim(); }
function int(value, label, min = 0, max = 1_000_000_000) { need(Number.isSafeInteger(value) && value >= min && value <= max, `${label} غير صالح`); return value; }
function role(u, ...roles) { need(roles.includes(u.role), 'ليست لديك صلاحية لهذه العملية', 403); }
function transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } }
function audit(u, action, entity) { sql('INSERT INTO audit(actor_id,action,entity,created) VALUES(?,?,?,?)', u.id, action, String(entity), now()); }
function event(u, id, action, note = '') { sql('INSERT INTO events(suborder_id,actor_id,action,note,created) VALUES(?,?,?,?,?)', id, u.id, action, note, now()); }

if (!one('SELECT id FROM users LIMIT 1')) {
  const secret = demo ? 'RafidDemo2026!' : process.env.ADMIN_PASSWORD;
  if (!secret || secret.length < 12 || secret === 'replace-with-a-unique-long-password') throw new Error('Set a unique ADMIN_PASSWORD of at least 12 characters or run npm run demo locally.');
  transaction(() => {
    sql('INSERT INTO users(name,email,password,role) VALUES(?,?,?,?)', 'إدارة رافد', 'admin@rafid.local', password(secret), 'admin');
    if (!demo) return;
    sql("INSERT INTO suppliers(id,name,zone,fee,minimum,active,delivery) VALUES(1,'مؤسسة الشام للتجارة','دمشق',15000,50000,1,'غدًا 09:00–13:00'),(2,'بيت المونة للتوزيع','دمشق',10000,40000,1,'غدًا 10:00–14:00')");
    for (const [name,email,r,sid] of [['أسواق البركة','merchant@rafid.local','merchant',null],['مؤسسة الشام','supplier@rafid.local','supplier',1],['بيت المونة','supplier2@rafid.local','supplier',2],['أحمد · سائق المورد','driver@rafid.local','driver',1],['خالد · سائق رافد','platform@rafid.local','driver',null]]) sql('INSERT INTO users(name,email,password,role,supplier_id) VALUES(?,?,?,?,?)',name,email,password(secret),r,sid);
    sql("INSERT INTO drivers(user_id,supplier_id,zone,capacity,max_orders) VALUES(5,1,'دمشق',1500,5),(6,NULL,'دمشق',2000,8)");
    for (const [name,brand,pack,category,weight] of [['أرز بسمتي','الوليمة','كيس 5 كغ','حبوب وبقول',5],['زيت دوار الشمس','شمس','كرتونة 6 × 1 لتر','زيوت وسمن',6],['سكر أبيض','الأسرة','كيس 10 كغ','مواد أساسية',10],['معكرونة','الريف','كرتونة 20 × 400 غ','معلبات ومعكرونة',8],['عدس أحمر','المونة','كيس 5 كغ','حبوب وبقول',5],['معجون طماطم','بلادي','كرتونة 12 × 800 غ','معلبات ومعكرونة',10]]) sql('INSERT INTO products(name,brand,pack,category,weight) VALUES(?,?,?,?,?)',name,brand,pack,category,weight);
    for (let p=1;p<=6;p++) for(let s=1;s<=2;s++) sql('INSERT INTO listings(supplier_id,product_id,price,stock,min_qty,updated) VALUES(?,?,?,?,?,?)',s,p,[85000,165000,110000,130000,65000,180000][p-1]+(s===2?(p%2?-5000:5000):0),50,1,now());
    sql('INSERT INTO offers(listing_id,price,merchant_id,starts,ends,max_uses) VALUES(?,?,?,?,?,?)',1,75000,2,now(),new Date(Date.now()+7*86400000).toISOString(),20);
  });
}
// Demo databases must never silently become production databases.
if (!demo && one("SELECT id FROM users WHERE email='merchant@rafid.local'")) throw new Error('Demo database detected. Use a fresh DB_PATH for production.');

const offerEngine=createOfferEngine({db,need,int,str,transaction,audit});

function accessible(u, id) {
  const sub = one('SELECT s.*,o.merchant_id,o.address,o.zone,o.created,o.id parent_id,u.name merchant_name,sp.name supplier_name FROM suborders s JOIN orders o ON o.id=s.order_id JOIN users u ON u.id=o.merchant_id JOIN suppliers sp ON sp.id=s.supplier_id WHERE s.id=?',id);
  need(sub, 'الطلب غير موجود',404);
  const allowed = u.role==='admin' || (u.role==='merchant'&&sub.merchant_id===u.id) || (u.role==='supplier'&&sub.supplier_id===u.supplier_id) || (u.role==='driver'&&sub.trip_id&&one('SELECT id FROM trips WHERE id=? AND driver_id=?',sub.trip_id,u.id));
  need(allowed,'الطلب غير موجود',404); return sub;
}
function fullSub(u, sub) {
  const copy = {...sub}; delete copy.proof; delete copy.proof_attempts; delete copy.proof_expires;
  copy.items = all('SELECT id,product_id,name,pack,quantity,price,weight FROM order_items WHERE suborder_id=?',sub.id);
  copy.events = all('SELECT e.action,e.note,e.created,u.name actor FROM events e JOIN users u ON u.id=e.actor_id WHERE suborder_id=? ORDER BY e.id',sub.id);
  copy.complaints = u.role==='driver'?[]:all('SELECT * FROM complaints WHERE suborder_id=?',sub.id);
  copy.rating = one('SELECT score FROM ratings WHERE suborder_id=?',sub.id)?.score || null;
  if (u.role==='merchant' && ['picked_up','in_transit','arrived','failed'].includes(sub.status)) copy.deliveryCode=sub.proof && sub.proof_expires>Date.now()?sub.proof:null;
  if (sub.trip_id) copy.driver_name=one('SELECT u.name FROM trips t JOIN users u ON u.id=t.driver_id WHERE t.id=?',sub.trip_id)?.name;
  return copy;
}
function catalog(u,context={}) {
  return all('SELECT l.*,p.name,p.brand,p.pack,p.category,p.weight,s.name supplier_name,s.zone,s.fee,s.minimum,s.delivery FROM listings l JOIN products p ON p.id=l.product_id JOIN suppliers s ON s.id=l.supplier_id WHERE s.active=1 ORDER BY p.id,s.id').map(l=>{
    const policy=offerEngine.forListing(l,u,{zone:context.zone,quantity:context.quantities?.get(l.id)||1});
    const rating=one('SELECT round(avg(r.score),1) score FROM ratings r JOIN suborders s ON s.id=r.suborder_id WHERE s.supplier_id=?',l.supplier_id);
    return {...l,base_price:l.price,...policy,rating:rating?.score||null};
  });
}
function nextDelivery(s) {
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Damascus',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(new Date()).map(p=>[p.type,p.value]));
  const today=new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`),days=s.weekdays.split(',').map(Number),lead=Number(parts.hour)>=s.cutoff_hour?2:1;
  for(let offset=lead;offset<=14;offset++) {
    const day=new Date(today.getTime()+offset*86400000),key=day.toISOString().slice(0,10);
    if(!days.includes(day.getUTCDay())) continue;
    const count=one("SELECT count(*) n FROM suborders WHERE supplier_id=? AND delivery_date=? AND status NOT IN ('cancelled','rejected','expired')",s.id,key).n;
    if(count<s.daily_capacity) return {date:key,label:`${key} · ${s.delivery.replace(/^غدًا\s*/, '')}`};
  }
  fail(422,`لا مواعيد متاحة خلال أسبوعين لدى ${s.name}`);
}
function priceCart(u,b) {
  const zone=str(b.zone,'المنطقة',60), address=str(b.address,'العنوان',500);
  need(Array.isArray(b.items)&&b.items.length>0&&b.items.length<=100,'السلة فارغة أو كبيرة جدًا');
  const available=catalog(u,{zone,quantities:new Map(b.items.map(i=>[i.listing_id,i.quantity]))}), seen=new Set(), groups=new Map();
  for(const i of b.items) {
    int(i.listing_id,'المنتج',1); int(i.quantity,'الكمية',1,10000); need(!seen.has(i.listing_id),'منتج مكرر'); seen.add(i.listing_id);
    const l=available.find(x=>x.id===i.listing_id); need(l,'عرض غير متاح'); need(l.zone===zone,'المورد لا يخدم هذه المنطقة'); need(i.quantity>=l.min_qty,'لم يتحقق الحد الأدنى للكمية'); need(i.quantity<=l.stock,'المخزون غير كافٍ');
    if(!groups.has(l.supplier_id)) {const s=one('SELECT * FROM suppliers WHERE id=?',l.supplier_id),slot=nextDelivery(s);groups.set(l.supplier_id,{supplier_id:l.supplier_id,supplier_name:l.supplier_name,fee:l.fee,minimum:l.minimum,delivery:slot.label,delivery_date:slot.date,subtotal:0,items:[]});}
    const g=groups.get(l.supplier_id); g.subtotal+=l.price*i.quantity;
    g.items.push({listing_id:l.id,product_id:l.product_id,name:l.name,pack:l.pack,quantity:i.quantity,price:l.price,weight:l.weight,offer_id:l.offer_id});
  }
  const result=[...groups.values()]; for(const g of result) { need(g.subtotal>=g.minimum,`الحد الأدنى لدى ${g.supplier_name}: ${g.minimum.toLocaleString()} ل.س`); g.total=g.subtotal+g.fee; }
  const total=result.reduce((s,g)=>s+g.total,0); need(Number.isSafeInteger(total)&&total<=1_000_000_000,'إجمالي السلة يتجاوز الحد المسموح');
  return {zone,address,groups:result,total,currency:'SYP',pricePolicy:'السعر ينتظر تأكيد المورد؛ لا تعديل دون موافقتك'};
}
function release(sub) {
  for(const i of all('SELECT * FROM order_items WHERE suborder_id=?',sub.id)) { sql('UPDATE listings SET stock=stock+? WHERE id=?',i.quantity,i.listing_id); if(i.offer_id) offerEngine.release(i.offer_id,i.quantity); }
}
function expireReservations() {
  const expired=all("SELECT * FROM suborders WHERE status='pending' AND expires<?",Date.now());
  if(!expired.length) return;
  transaction(()=>{ for(const sub of expired) { release(sub); sql("UPDATE suborders SET status='expired' WHERE id=?",sub.id); sql("INSERT INTO events(suborder_id,actor_id,action,note,created) VALUES(?,1,'expired','انتهت مهلة موافقة المورد وتحرر المخزون',?)",sub.id,now()); } });
}

const loginAttempts=new Map();
async function api(req,res,url,u,b) {
  const p=url.pathname, method=req.method;
  if(p==='/api/config'&&method==='GET') return {demo,currency:'SYP'};
  if(p==='/api/health'&&method==='GET') return {ok:one('SELECT 1 ok').ok===1};
  if(p==='/api/login'&&method==='POST') {
    const ip=req.socket.remoteAddress, entry=loginAttempts.get(ip);
    need(!entry||entry.until<Date.now()||entry.count<8,'محاولات كثيرة. حاول بعد 15 دقيقة',429);
    const email=str(b.email,'البريد',160).toLowerCase(), secret=str(b.password,'كلمة المرور',200), user=one('SELECT * FROM users WHERE email=?',email);
    if(!user||!user.active||!verify(secret,user.password)) { const prev=entry&&entry.until>Date.now()?entry:{count:0,until:Date.now()+900000}; prev.count++; loginAttempts.set(ip,prev); fail(401,'بيانات الدخول غير صحيحة'); }
    loginAttempts.delete(ip); const session=token(); sql('INSERT INTO sessions VALUES(?,?,?)',hash(session),user.id,Date.now()+12*3600000);
    res.setHeader('Set-Cookie',`rafid_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${process.env.SECURE_COOKIES==='1'?'; Secure':''}`);
    return {id:user.id,name:user.name,role:user.role,supplier_id:user.supplier_id};
  }
  if(p==='/api/register'&&method==='POST') {
    const name=str(b.name,'اسم المحل',120),email=str(b.email,'البريد',160).toLowerCase(),secret=str(b.password,'كلمة المرور',200);
    need(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),'بريد غير صالح'); need(secret.length>=12,'كلمة المرور 12 حرفًا على الأقل'); need(!one('SELECT id FROM users WHERE email=?',email),'البريد مستخدم',409);
    const count=one("SELECT count(*) n FROM users WHERE role='merchant'").n; need(count<1000,'التسجيل مغلق لهذه التجربة');
    sql("INSERT INTO users(name,email,password,role) VALUES(?,?,?,'merchant')",name,email,password(secret)); return {ok:true};
  }
  need(u,'سجل الدخول أولًا',401);
  if(p==='/api/me'&&method==='GET') return {id:u.id,name:u.name,role:u.role,supplier_id:u.supplier_id};
  if(p==='/api/address'&&method==='GET') {role(u,'merchant');return one('SELECT zone,address FROM addresses WHERE user_id=?',u.id)||{zone:'دمشق',address:''};}
  if(p==='/api/logout'&&method==='POST') { sql('DELETE FROM sessions WHERE token=?',u.sessionHash); res.setHeader('Set-Cookie','rafid_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return {ok:true}; }
  expireReservations();
  if(p==='/api/catalog'&&method==='GET') { role(u,'merchant','admin'); return catalog(u); }
  if(p==='/api/products'&&method==='GET') { role(u,'admin','supplier'); return all('SELECT * FROM products ORDER BY id'); }
  if(p==='/api/products'&&method==='POST') {
    role(u,'admin'); const name=str(b.name,'المنتج'),brand=str(b.brand,'العلامة'),pack=str(b.pack,'العبوة'),category=str(b.category,'التصنيف');
    need(Number.isFinite(b.weight)&&b.weight>=0&&b.weight<=10000,'وزن غير صالح');
    need(!one('SELECT id FROM products WHERE name=? AND brand=? AND pack=?',name,brand,pack),'المنتج موجود بهذه المواصفات',409);
    const r=sql('INSERT INTO products(name,brand,pack,category,weight) VALUES(?,?,?,?,?)',name,brand,pack,category,b.weight); audit(u,'product.create',r.lastInsertRowid); return {id:Number(r.lastInsertRowid)};
  }
  if(p==='/api/suppliers'&&method==='GET') { role(u,'admin'); return all('SELECT * FROM suppliers'); }
  if(p==='/api/suppliers'&&method==='POST') {
    role(u,'admin'); const name=str(b.name,'المورد'),zone=str(b.zone,'المنطقة',60),email=str(b.email,'البريد',160).toLowerCase(),secret=str(b.password,'كلمة المرور',200); need(secret.length>=12,'كلمة المرور 12 حرفًا على الأقل'); need(!one('SELECT id FROM users WHERE email=?',email),'البريد مستخدم',409);
    int(b.fee,'التوصيل'); int(b.minimum,'الحد الأدنى');
    return transaction(()=>{ const r=sql('INSERT INTO suppliers(name,zone,fee,minimum,active,delivery) VALUES(?,?,?,?,0,?)',name,zone,b.fee,b.minimum,str(b.delivery,'موعد التوصيل')); const id=Number(r.lastInsertRowid); sql("INSERT INTO users(name,email,password,role,supplier_id) VALUES(?,?,?,'supplier',?)",name,email,password(secret),id); audit(u,'supplier.create',id); return {id}; });
  }
  if(/^\/api\/suppliers\/\d+\/activate$/.test(p)&&method==='POST') { role(u,'admin'); need(typeof b.active==='boolean','حالة غير صالحة'); const id=Number(p.split('/')[3]); need(one('SELECT id FROM suppliers WHERE id=?',id),'المورد غير موجود',404); sql('UPDATE suppliers SET active=? WHERE id=?',b.active?1:0,id); audit(u,'supplier.activation',id); return {ok:true}; }
  if(p==='/api/store'&&method==='GET') { role(u,'supplier'); return one('SELECT * FROM suppliers WHERE id=?',u.supplier_id); }
  if(p==='/api/store'&&method==='POST') { role(u,'supplier'); int(b.fee,'التوصيل'); int(b.minimum,'الحد الأدنى'); const weekdays=str(b.weekdays,'أيام الخدمة',20); need(/^[0-6](,[0-6])*$/.test(weekdays),'الأيام أرقام من 0 للأحد إلى 6 للسبت مفصولة بفاصلة');int(b.cutoff_hour,'ساعة إغلاق طلبات الغد',0,23);int(b.daily_capacity,'السعة اليومية',1,10000);sql('UPDATE suppliers SET zone=?,fee=?,minimum=?,delivery=?,weekdays=?,cutoff_hour=?,daily_capacity=? WHERE id=?',str(b.zone,'المنطقة',60),b.fee,b.minimum,str(b.delivery,'فترة التوصيل'),weekdays,b.cutoff_hour,b.daily_capacity,u.supplier_id); audit(u,'store.update',u.supplier_id); return {ok:true}; }
  if(p==='/api/listings'&&method==='GET') { role(u,'supplier'); return all('SELECT l.*,p.name,p.brand,p.pack FROM listings l JOIN products p ON p.id=l.product_id WHERE supplier_id=?',u.supplier_id); }
  if(p==='/api/listings'&&method==='POST') {
    role(u,'supplier'); int(b.product_id,'المنتج',1); int(b.price,'السعر',1); int(b.stock,'المخزون',0,1000000); int(b.min_qty,'الحد الأدنى',1,10000); need(one('SELECT id FROM products WHERE id=?',b.product_id),'منتج غير موجود');
    sql('INSERT INTO listings(supplier_id,product_id,price,stock,min_qty,updated) VALUES(?,?,?,?,?,?) ON CONFLICT(supplier_id,product_id) DO UPDATE SET price=excluded.price,stock=excluded.stock,min_qty=excluded.min_qty,updated=excluded.updated',u.supplier_id,b.product_id,b.price,b.stock,b.min_qty,now()); audit(u,'listing.update',b.product_id); return {ok:true};
  }
  if(p==='/api/merchants'&&method==='GET') {
    role(u,'supplier','admin');
    // Private pricing can target only a merchant with an existing commercial relationship.
    return u.role==='admin'?all("SELECT id,name FROM users WHERE role='merchant'"):all('SELECT DISTINCT u.id,u.name FROM users u JOIN orders o ON o.merchant_id=u.id JOIN suborders s ON s.order_id=o.id WHERE s.supplier_id=?',u.supplier_id);
  }
  if(p==='/api/offer-groups'&&method==='GET'){role(u,'supplier');return offerEngine.groups(u);}
  if(p==='/api/offer-groups'&&method==='POST'){role(u,'supplier');return offerEngine.saveGroup(u,b);}
  if(p==='/api/offers'&&method==='GET'){role(u,'supplier');return offerEngine.listing(u.supplier_id);}
  if(p==='/api/offers'&&method==='POST'){role(u,'supplier');return offerEngine.save(u,b);}
  if(/^\/api\/offers\/\d+$/.test(p)&&method==='POST'){role(u,'supplier');return offerEngine.save(u,b,Number(p.split('/')[3]));}
  if(p==='/api/quotes'&&method==='POST') {
    role(u,'merchant'); const quote=priceCart(u,b), id=token(),expires=Date.now()+10*60000;
    sql('INSERT INTO quotes VALUES(?,?,?,?)',id,u.id,JSON.stringify(quote),expires); return {...quote,id,expires};
  }
  if(p==='/api/recommendations'&&method==='POST') {
    role(u,'merchant');const reference=priceCart(u,b),available=catalog(u).filter(l=>l.zone===reference.zone),quantities=new Map();
    for(const g of reference.groups)for(const i of g.items)quantities.set(i.product_id,(quantities.get(i.product_id)||0)+i.quantity);
    need(quantities.size<=10,'اقتراح الخطة متاح حتى عشرة منتجات مختلفة في السلة');
    const options=[...quantities].map(([product_id,quantity])=>available.filter(l=>l.product_id===product_id&&l.stock>=quantity&&quantity>=l.min_qty).map(l=>({listing_id:l.id,quantity})));
    let examined=0,best=reference,bestItems=b.items;const limit=512;
    function visit(index,items){if(examined>=limit)return;if(index===options.length){examined++;try{const q=priceCart(u,{zone:reference.zone,address:reference.address,items});if(q.total<best.total){best=q;bestItems=items.map(i=>({...i}));}}catch(e){if(!e.status)throw e;}return;}for(const i of options[index]){visit(index+1,[...items,i]);if(examined>=limit)break;}}
    visit(0,[]);const saving=reference.total-best.total;return {items:bestItems,total:best.total,reference_total:reference.total,saving,saving_percent:reference.total>0?Math.round(saving/reference.total*10000)/100:0,examined,capped:examined>=limit,description:'أفضل تكلفة ضمن الخطط المفحوصة لنفس المنتجات والعبوات والكميات، شاملة توصيل كل مورد. المرجع سلتك الحالية.',groups:best.groups};
  }
  if(p==='/api/orders'&&method==='POST') {
    role(u,'merchant'); const key=str(req.headers['idempotency-key'],'مفتاح التأكيد',100),quoteId=str(b.quote_id,'عرض السعر',100),fingerprint=hash(quoteId);
    return transaction(()=>{
      const existing=one('SELECT * FROM orders WHERE merchant_id=? AND idempotency=?',u.id,key);
      if(existing) { need(existing.fingerprint===fingerprint,'مفتاح مكرر لعملية مختلفة',409); return {id:existing.id,reused:true}; }
      const row=one('SELECT * FROM quotes WHERE id=? AND user_id=?',quoteId,u.id); need(row&&row.expires>Date.now(),'انتهت صلاحية عرض السعر؛ حدّث السلة',409);
      const q=JSON.parse(row.payload), fresh=priceCart(u,{zone:q.zone,address:q.address,items:q.groups.flatMap(g=>g.items.map(i=>({listing_id:i.listing_id,quantity:i.quantity})))});
      need(JSON.stringify(q)===JSON.stringify(fresh),'تغير السعر أو التوصيل. راجع السلة مجددًا',409);
      const r=sql('INSERT INTO orders(merchant_id,address,zone,total,created,idempotency,fingerprint) VALUES(?,?,?,?,?,?,?)',u.id,q.address,q.zone,q.total,now(),key,fingerprint),id=Number(r.lastInsertRowid);
      sql('INSERT INTO addresses(user_id,zone,address) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET zone=excluded.zone,address=excluded.address',u.id,q.zone,q.address);
      for(const g of q.groups) {
        const sr=sql("INSERT INTO suborders(order_id,supplier_id,status,total,fee,delivery,delivery_date,expires) VALUES(?,?,'pending',?,?,?,?,?)",id,g.supplier_id,g.total,g.fee,g.delivery,g.delivery_date,Date.now()+24*3600000),sid=Number(sr.lastInsertRowid);
        for(const i of g.items) {
          need(sql('UPDATE listings SET stock=stock-? WHERE id=? AND stock>=?',i.quantity,i.listing_id,i.quantity).changes===1,'نفد المخزون',409);
          if(i.offer_id) offerEngine.reserve(i.offer_id,i.quantity);
          sql('INSERT INTO order_items(suborder_id,listing_id,product_id,name,pack,quantity,price,weight,offer_id) VALUES(?,?,?,?,?,?,?,?,?)',sid,i.listing_id,i.product_id,i.name,i.pack,i.quantity,i.price,i.weight,i.offer_id);
        }
        event(u,sid,'pending','بانتظار تأكيد المورد للسعر والمخزون');
      }
      audit(u,'order.create',id); return {id};
    });
  }
  if(p==='/api/orders'&&method==='GET') {
    if(u.role==='merchant') return all('SELECT * FROM orders WHERE merchant_id=? ORDER BY id DESC',u.id).map(o=>({...o,suborders:all('SELECT id FROM suborders WHERE order_id=?',o.id).map(s=>fullSub(u,accessible(u,s.id)))}));
    const ids=u.role==='admin'?all('SELECT id FROM suborders ORDER BY id DESC'):u.role==='supplier'?all('SELECT id FROM suborders WHERE supplier_id=? ORDER BY id DESC',u.supplier_id):all('SELECT s.id FROM suborders s JOIN trips t ON t.id=s.trip_id WHERE t.driver_id=? ORDER BY s.id DESC',u.id);
    return ids.map(s=>fullSub(u,accessible(u,s.id)));
  }
  if(/^\/api\/suborders\/\d+\/action$/.test(p)&&method==='POST') {
    return transaction(()=>{
      const sub=accessible(u,Number(p.split('/')[3])),action=str(b.action,'الإجراء',30), note=typeof b.note==='string'?b.note.trim().slice(0,500):'';
      const transitions={confirm:['pending','confirmed','supplier'],prepare:['confirmed','preparing','supplier'],ready:['preparing','ready','supplier'],accept:['assigned','accepted','driver'],pickup:['accepted','picked_up','driver'],depart:['picked_up','in_transit','driver'],arrive:['in_transit','arrived','driver']};
      if(transitions[action]) {
        const [from,to,actor]=transitions[action]; role(u,actor); need(sub.status===from,'حالة الطلب تغيرت؛ حدّث الصفحة',409);
        if(action==='depart') need(!one("SELECT id FROM suborders WHERE trip_id=? AND status IN ('assigned','accepted')",sub.trip_id),'استلم بضائع الرحلة كاملة قبل بدء التوصيل');
        if(action==='confirm') need(one('SELECT active FROM suppliers WHERE id=?',sub.supplier_id).active,'المورد غير مفعل');
        if(action==='pickup') sql('UPDATE suborders SET proof=?,proof_attempts=0,proof_expires=? WHERE id=?',String(100000+randomBytes(4).readUInt32BE()%900000),Date.now()+24*3600000,sub.id);
        sql('UPDATE suborders SET status=? WHERE id=?',to,sub.id); event(u,sub.id,to,note);
      } else if(action==='reject'||action==='cancel') {
        if(action==='reject') { role(u,'supplier'); need(sub.status==='pending','يمكن رفض طلب بانتظار الموافقة فقط'); }
        else { role(u,'merchant','admin'); need(sub.status==='pending','الإلغاء الذاتي متاح قبل قبول المورد فقط'); }
        need(note.length>0,'اذكر السبب'); release(sub); sql('UPDATE suborders SET status=? WHERE id=?',action==='reject'?'rejected':'cancelled',sub.id); event(u,sub.id,action==='reject'?'rejected':'cancelled',note);
      } else if(action==='decline') {role(u,'driver');need(sub.status==='assigned','رفض المهمة قبل قبولها فقط');need(note.length>0,'اذكر سبب الرفض');sql("UPDATE suborders SET status='ready',trip_id=NULL WHERE id=?",sub.id);event(u,sub.id,'ready',`رفض السائق المهمة: ${note}`);}
      else if(action==='receipt') {role(u,'merchant');need(sub.status==='delivered','تأكيد الاستلام بعد التسليم');need(!sub.collection_confirmed,'سبق تأكيد الاستلام');sql('UPDATE suborders SET collection_confirmed=1 WHERE id=?',sub.id);event(u,sub.id,'receipt',`أكد المحل استلام البضاعة ومبلغ التحصيل ${sub.collection} ل.س`);}
      else if(action==='platform') { role(u,'supplier'); need(sub.status==='ready','يجب تجهيز الطلب أولًا'); sql("UPDATE suborders SET method='platform' WHERE id=?",sub.id); event(u,sub.id,'platform_requested'); }
      else if(action==='fail') { role(u,'driver'); need(['picked_up','in_transit','arrived'].includes(sub.status),'لا يمكن تسجيل تعذر الآن'); need(note.length>0,'اذكر سبب التعذر'); sql("UPDATE suborders SET status='failed' WHERE id=?",sub.id); event(u,sub.id,'failed',note); }
      else if(action==='retry') { role(u,'admin'); need(sub.status==='failed','الطلب غير متعثر'); need(note.length>0,'وثق عودة الحمولة للمورد قبل إعادة الإسناد'); sql("UPDATE suborders SET status='ready',trip_id=NULL,proof=NULL,proof_attempts=0,proof_expires=NULL WHERE id=?",sub.id); event(u,sub.id,'ready',note); }
      else fail(422,'إجراء غير معروف');
      audit(u,`suborder.${action}`,sub.id); return {ok:true};
    });
  }
  if(/^\/api\/suborders\/\d+\/deliver$/.test(p)&&method==='POST') {
    role(u,'driver'); const sub=accessible(u,Number(p.split('/')[3])); need(sub.status==='arrived','أكد الوصول إلى المحل أولًا');
    need(sub.proof_attempts<5,'تم قفل الرمز بعد محاولات خاطئة؛ تواصل مع الإدارة',429);
    if(!sub.proof||sub.proof_expires<Date.now()||String(b.code)!==sub.proof) { sql('UPDATE suborders SET proof_attempts=proof_attempts+1 WHERE id=?',sub.id); fail(422,'رمز خاطئ أو منتهي'); }
    int(b.collection,'المبلغ المحصل',0,sub.total);
    return transaction(()=>{ sql("UPDATE suborders SET status='delivered',proof=NULL,collection=? WHERE id=?",b.collection,sub.id); event(u,sub.id,'delivered',`تم التسليم بإثبات وتسجيل تحصيل ${b.collection} ل.س؛ يحتاج مطابقة المستلم`); audit(u,'delivery.complete',sub.id); return {ok:true}; });
  }
  if(p==='/api/drivers'&&method==='GET') { role(u,'supplier','admin'); return all(`SELECT d.*,u.name,u.email FROM drivers d JOIN users u ON u.id=d.user_id WHERE u.active=1 ${u.role==='supplier'?'AND d.supplier_id=?':''}`, ...(u.role==='supplier'?[u.supplier_id]:[])); }
  if(p==='/api/drivers'&&method==='POST') {
    role(u,'supplier','admin'); const name=str(b.name,'السائق'),email=str(b.email,'البريد',160).toLowerCase(),secret=str(b.password,'كلمة المرور',200); need(secret.length>=12,'كلمة المرور 12 حرفًا على الأقل'); need(!one('SELECT id FROM users WHERE email=?',email),'البريد مستخدم',409); const zone=str(b.zone,'المنطقة',60); need(Number.isFinite(b.capacity)&&b.capacity>0&&b.capacity<=100000,'سعة غير صالحة'); int(b.max_orders,'عدد الطلبات',1,50);
    return transaction(()=>{ const r=sql("INSERT INTO users(name,email,password,role,supplier_id) VALUES(?,?,?,'driver',?)",name,email,password(secret),u.role==='supplier'?u.supplier_id:null),id=Number(r.lastInsertRowid); sql('INSERT INTO drivers(user_id,supplier_id,zone,capacity,max_orders) VALUES(?,?,?,?,?)',id,u.role==='supplier'?u.supplier_id:null,zone,b.capacity,b.max_orders); audit(u,'driver.create',id); return {id}; });
  }
  if(p==='/api/dispatch'&&method==='POST') {
    role(u,'supplier','admin'); return transaction(()=>{
      need(Array.isArray(b.suborder_ids)&&b.suborder_ids.length>0&&b.suborder_ids.length<=50,'اختر طلبًا أو أكثر'); const ids=[...new Set(b.suborder_ids.map(x=>int(x,'الطلب',1)))];
      const d=one('SELECT d.*,u.active FROM drivers d JOIN users u ON u.id=d.user_id WHERE user_id=?',int(b.driver_id,'السائق',1)); need(d&&d.active&&d.available,'سائق غير متاح');
      if(u.role==='supplier') need(d.supplier_id===u.supplier_id,'السائق ليس تابعًا لك',403); else need(d.supplier_id===null,'إدارة رافد تسند إلى سائقي المنصة فقط');
      const subs=ids.map(id=>accessible(u,id)); for(const s of subs) { need(s.status==='ready','الطلب غير جاهز أو مسند بالفعل',409); need(s.zone===d.zone,'السائق لا يغطي المنطقة'); need(d.supplier_id===null?s.method==='platform':s.supplier_id===d.supplier_id&&s.method==='supplier','جهة السائق لا توافق طريقة التوصيل'); }
      const active=all("SELECT s.id FROM suborders s JOIN trips t ON t.id=s.trip_id WHERE t.driver_id=? AND s.status NOT IN ('delivered','cancelled','rejected','expired')",d.user_id);
      need(active.length===0,'أكمل الرحلة الحالية قبل بدء رحلة جديدة'); need(subs.length<=d.max_orders,'عدد الطلبات يتجاوز سعة الرحلة');
      let weight=0,unknown=false; for(const s of subs) for(const i of all('SELECT weight,quantity FROM order_items WHERE suborder_id=?',s.id)) { weight+=i.weight*i.quantity; if(i.weight===0) unknown=true; }
      need(weight<=d.capacity,'وزن الحمولة يتجاوز سعة المركبة'); if(unknown) need(u.role==='admin'&&b.ack_unknown===true,'وزن بعض المنتجات مجهول؛ يلزم تأكيد عمليات رافد بعد مراجعة الحمولة');
      const r=sql('INSERT INTO trips(driver_id,created) VALUES(?,?)',d.user_id,now()),id=Number(r.lastInsertRowid);
      for(const s of subs) { sql("UPDATE suborders SET trip_id=?,status='assigned' WHERE id=?",id,s.id); event(u,s.id,'assigned',`رحلة ${id} · ${unknown?'حمولة تقديرية راجعتها العمليات':weight+' كغ'} · استلام جميع الطلبات قبل بدء التسليم`); }
      audit(u,'trip.create',id); return {id,weight,estimated:unknown};
    });
  }
  if(p==='/api/complaints'&&method==='POST') { role(u,'merchant'); const s=accessible(u,int(b.suborder_id,'الطلب',1)); need(['delivered','failed','arrived'].includes(s.status),'البلاغ متاح عند الوصول أو التعذر أو التسليم'); const message=str(b.message,'وصف المشكلة',1000); sql('INSERT INTO complaints(suborder_id,merchant_id,message,created) VALUES(?,?,?,?)',s.id,u.id,message,now()); event(u,s.id,'complaint',message); return {ok:true}; }
  if(/^\/api\/complaints\/\d+$/.test(p)&&method==='POST') { role(u,'admin'); const id=Number(p.split('/')[3]); need(one('SELECT id FROM complaints WHERE id=?',id),'البلاغ غير موجود',404); sql("UPDATE complaints SET status='resolved',resolution=? WHERE id=?",str(b.resolution,'قرار المعالجة',1000),id); audit(u,'complaint.resolve',id); return {ok:true}; }
  if(p==='/api/ratings'&&method==='POST') { role(u,'merchant'); const s=accessible(u,int(b.suborder_id,'الطلب',1)); need(s.status==='delivered','التقييم بعد التسليم فقط'); int(b.score,'التقييم',1,5); need(!one('SELECT id FROM ratings WHERE suborder_id=?',s.id),'تم تقييم الطلب سابقًا',409); sql('INSERT INTO ratings(suborder_id,merchant_id,score) VALUES(?,?,?)',s.id,u.id,b.score); return {ok:true}; }
  if(p==='/api/report'&&method==='GET') {
    role(u,'admin','supplier'); const where=u.role==='supplier'?' WHERE s.supplier_id=?':'', args=u.role==='supplier'?[u.supplier_id]:[];
    const subs=all(`SELECT s.*,o.merchant_id FROM suborders s JOIN orders o ON o.id=s.order_id${where}`,...args);
    const delivered=subs.filter(s=>s.status==='delivered'); return {orders:subs.length,completed:delivered.length,pending:subs.filter(s=>s.status==='pending').length,failed:subs.filter(s=>s.status==='failed').length,gmv:delivered.reduce((a,s)=>a+s.total-s.fee,0),collections:delivered.reduce((a,s)=>a+s.collection,0),merchants:new Set(subs.map(s=>s.merchant_id)).size,audit:u.role==='admin'?all('SELECT a.*,u.name actor FROM audit a JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 100'):[]};
  }
  fail(404,'المسار غير موجود');
}

const files={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/styles.css':['styles.css','text/css; charset=utf-8'],'/manifest.webmanifest':['manifest.webmanifest','application/manifest+json'],'/icon.svg':['icon.svg','image/svg+xml']};
const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','same-origin'); res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  try {
    const url=new URL(req.url,'http://localhost');
    if(url.pathname.startsWith('/api/')) {
      res.setHeader('Content-Type','application/json; charset=utf-8'); res.setHeader('Cache-Control','no-store');
      if(!['GET','POST'].includes(req.method)) fail(405,'طريقة غير مسموحة');
      if(req.method==='POST') {
        const origin=req.headers.origin; const expected=process.env.PUBLIC_ORIGIN;
        if(origin) { const allowed=expected?origin===expected:origin===`http://${req.headers.host}`; need(allowed,'مصدر الطلب غير مسموح',403); }
        need((req.headers['content-type']||'').startsWith('application/json'),'المحتوى يجب أن يكون JSON',415);
      }
      let raw=''; for await(const part of req) {raw+=part; need(Buffer.byteLength(raw)<=65536,'حجم الطلب كبير',413);}
      let b={}; if(raw) {try{b=JSON.parse(raw);}catch{fail(400,'JSON غير صالح');} need(b&&typeof b==='object'&&!Array.isArray(b),'محتوى غير صالح',400);}
      const session=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('rafid_session='))?.slice(14);
      const sessionHash=session?hash(session):'';
      const u=session?one('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.active=1',sessionHash,Date.now()):null;
      if(u) u.sessionHash=sessionHash;
      const result=await api(req,res,url,u,b); res.end(JSON.stringify(result));
    }else {
      need(req.method==='GET','طريقة غير مسموحة',405); const f=files[url.pathname]; need(f,'الصفحة غير موجودة',404); res.setHeader('Content-Type',f[1]); res.setHeader('Cache-Control','no-cache'); res.end(readFileSync(resolve(root,'public',f[0])));
    }
  }catch(e){res.statusCode=e.status||500;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify({error:e.status?e.message:'حدث خطأ داخلي',code:e.status||500}));if(!e.status)console.error(e);}
});
server.requestTimeout=15000;
server.listen(Number(process.env.PORT||3000),process.env.HOST||'127.0.0.1',()=>console.log(`RAFID listening on http://${process.env.HOST||'127.0.0.1'}:${process.env.PORT||3000} (${demo?'local demo':'pilot'})`));
function stop(){server.close(()=>{db.close();process.exit(0);});}
process.on('SIGTERM',stop); process.on('SIGINT',stop);
