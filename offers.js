// Offer policy is shared by catalog, quotes and transactional checkout.
export function createOfferEngine({db,need,int,str,transaction,audit}) {
  const one=(s,...a)=>db.prepare(s).get(...a),all=(s,...a)=>db.prepare(s).all(...a),run=(s,...a)=>db.prepare(s).run(...a);
  const columns=[['title',"TEXT NOT NULL DEFAULT 'عرض خاص'"],['terms',"TEXT NOT NULL DEFAULT ''"],['active','INTEGER NOT NULL DEFAULT 1'],['audience',"TEXT NOT NULL DEFAULT 'all'"],['group_id','INTEGER'],['target_zone','TEXT'],['discount_type',"TEXT NOT NULL DEFAULT 'fixed'"],['discount_value','INTEGER'],['min_qty','INTEGER NOT NULL DEFAULT 1'],['max_quantity','INTEGER'],['used_quantity','INTEGER NOT NULL DEFAULT 0'],['per_merchant_limit','INTEGER'],['inactivity_days','INTEGER NOT NULL DEFAULT 30']];
  const existing=all('PRAGMA table_info(offers)').map(c=>c.name);
  for(const [name,type] of columns)if(!existing.includes(name))db.exec(`ALTER TABLE offers ADD COLUMN ${name} ${type}`);
  db.exec(`CREATE TABLE IF NOT EXISTS offer_groups(id INTEGER PRIMARY KEY,supplier_id INTEGER NOT NULL REFERENCES suppliers(id),name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS offer_group_members(group_id INTEGER NOT NULL REFERENCES offer_groups(id),merchant_id INTEGER NOT NULL REFERENCES users(id),PRIMARY KEY(group_id,merchant_id));`);
  if(!existing.includes('used_quantity'))run("UPDATE offers SET used_quantity=COALESCE((SELECT sum(i.quantity) FROM order_items i JOIN suborders s ON s.id=i.suborder_id WHERE i.offer_id=offers.id AND s.status NOT IN ('cancelled','rejected','expired')),0)");
  if(!existing.includes('audience'))run("UPDATE offers SET audience='merchant' WHERE merchant_id IS NOT NULL");
  db.exec('PRAGMA user_version=3');
  const relationship=(supplierId,merchantId)=>one('SELECT o.id FROM orders o JOIN suborders s ON s.order_id=o.id JOIN users u ON u.id=o.merchant_id WHERE o.merchant_id=? AND s.supplier_id=? AND u.role=\'merchant\' AND u.active=1',merchantId,supplierId);
  function customerUses(offerId,merchantId){return one("SELECT count(*) n FROM order_items i JOIN suborders s ON s.id=i.suborder_id JOIN orders o ON o.id=s.order_id WHERE i.offer_id=? AND o.merchant_id=? AND s.status NOT IN ('cancelled','rejected','expired')",offerId,merchantId).n;}
  function price(o,base){const value=o.discount_value??o.price;return o.discount_type==='percent'?Math.max(1,Math.floor(base*(100-value)/100)):o.discount_type==='amount'?Math.max(1,base-value):value;}
  function eligible(o,l,u,{zone,quantity=1,ignoreQuantity=false}={}) {
    const instant=new Date().toISOString();
    if(!o.active||o.starts>instant||o.ends<=instant||o.uses>=o.max_uses||price(o,l.price)>=l.price)return false;
    if(o.max_quantity!==null&&(ignoreQuantity?o.used_quantity>=o.max_quantity:o.used_quantity+quantity>o.max_quantity))return false;
    if(!ignoreQuantity&&quantity<o.min_qty)return false;
    const audience=o.merchant_id?'merchant':o.audience;
    if(u.role!=='merchant'&&(audience!=='all'||o.per_merchant_limit))return false;
    if(audience==='merchant'&&o.merchant_id!==u.id)return false;
    if(audience==='group'&&!one('SELECT 1 FROM offer_group_members m JOIN offer_groups g ON g.id=m.group_id WHERE m.group_id=? AND m.merchant_id=? AND g.supplier_id=?',o.group_id,u.id,l.supplier_id))return false;
    if(audience==='zone'&&(zone||one('SELECT zone FROM addresses WHERE user_id=?',u.id)?.zone)!==o.target_zone)return false;
    if(audience==='first_order'&&one("SELECT s.id FROM suborders s JOIN orders ord ON ord.id=s.order_id WHERE ord.merchant_id=? AND s.supplier_id=? AND s.status NOT IN ('cancelled','rejected','expired')",u.id,l.supplier_id))return false;
    if(audience==='reactivation') {
      if(one("SELECT s.id FROM suborders s JOIN orders ord ON ord.id=s.order_id WHERE ord.merchant_id=? AND s.supplier_id=? AND s.status NOT IN ('delivered','cancelled','rejected','expired')",u.id,l.supplier_id))return false;
      const last=one("SELECT max(COALESCE((SELECT max(e.created) FROM events e WHERE e.suborder_id=s.id AND e.action='delivered'),ord.created)) last FROM suborders s JOIN orders ord ON ord.id=s.order_id WHERE ord.merchant_id=? AND s.supplier_id=? AND s.status='delivered'",u.id,l.supplier_id)?.last;
      if(!last||Date.parse(last)>Date.now()-o.inactivity_days*86400000)return false;
    }
    if(o.per_merchant_limit&&customerUses(o.id,u.id)>=o.per_merchant_limit)return false;
    return true;
  }
  const labels={all:'عرض عام',merchant:'عرض خاص بمحلك',group:'عرض لمجموعتك',zone:'عرض لمنطقتك',first_order:'لأول طلب من المورد',reactivation:'عرض عودة العملاء'};
  function forListing(l,u,context={}) {
    const candidates=all('SELECT * FROM offers WHERE listing_id=?',l.id).filter(o=>eligible(o,l,u,{...context,ignoreQuantity:true}));
    const applied=candidates.filter(o=>eligible(o,l,u,context)).sort((a,b)=>price(a,l.price)-price(b,l.price)||a.id-b.id)[0];
    const visible=candidates.map(o=>({id:o.id,title:o.title,terms:o.terms,price:price(o,l.price),min_qty:o.min_qty,ends:o.ends,remaining_quantity:o.max_quantity===null?null:o.max_quantity-o.used_quantity,label:labels[o.merchant_id?'merchant':o.audience],per_merchant_limit:o.per_merchant_limit}));
    return {price:applied?price(applied,l.price):l.price,offer_id:applied?.id||null,private_offer:!!applied&&(!!applied.merchant_id||['group','zone'].includes(applied.audience)),offer_title:applied?.title||null,offer_terms:applied?.terms||null,promotions:visible};
  }
  function listing(supplierId){return all('SELECT o.*,p.name,p.pack,g.name group_name FROM offers o JOIN listings l ON l.id=o.listing_id JOIN products p ON p.id=l.product_id LEFT JOIN offer_groups g ON g.id=o.group_id WHERE l.supplier_id=? ORDER BY o.id DESC',supplierId).map(o=>({...o,status:!o.active?'paused':o.ends<=new Date().toISOString()?'expired':o.uses>=o.max_uses||(o.max_quantity!==null&&o.used_quantity>=o.max_quantity)?'exhausted':o.starts>new Date().toISOString()?'scheduled':'active'}));}
  function save(u,b,id=null) {
    return transaction(()=>{
      const old=id?one('SELECT o.* FROM offers o JOIN listings l ON l.id=o.listing_id WHERE o.id=? AND l.supplier_id=?',id,u.supplier_id):null;
      if(id)need(old,'العرض غير موجود',404);
      const l=one('SELECT * FROM listings WHERE id=? AND supplier_id=?',int(b.listing_id,'المنتج',1),u.supplier_id);need(l,'المنتج غير موجود',404);if(old)need(l.id===old.listing_id,'أنشئ عرضًا جديدًا لتغيير المنتج');
      const type=b.discount_type||'fixed',value=b.discount_value??b.price;need(['fixed','percent','amount'].includes(type),'نوع الخصم غير صالح');int(value,'قيمة الخصم',1,type==='percent'?99:type==='amount'?l.price-1:l.price);
      const start=Date.parse(b.starts),end=Date.parse(b.ends);need(Number.isFinite(start)&&Number.isFinite(end)&&end>start&&end>Date.now(),'فترة العرض غير صالحة');
      const audience=b.audience||(b.merchant_id?'merchant':'all');need(Object.keys(labels).includes(audience),'الجمهور غير صالح');
      const merchant=audience==='merchant'?int(b.merchant_id,'المحل',1):null,group=audience==='group'?int(b.group_id,'المجموعة',1):null;
      if(merchant)need(relationship(u.supplier_id,merchant),'المحل غير مرتبط بطلباتك');
      if(group)need(one('SELECT id FROM offer_groups WHERE id=? AND supplier_id=?',group,u.supplier_id),'المجموعة ليست تابعة لك',404);
      const zone=audience==='zone'?str(b.target_zone,'المنطقة',60):null;
      const uses=int(b.max_uses,'حد الاستفادة',1,1000000),min=int(b.min_qty??1,'الحد الأدنى للكمية',1,10000);
      const max=b.max_quantity==null?null:int(b.max_quantity,'كمية العرض',min,10000000),per=b.per_merchant_limit==null?null:int(b.per_merchant_limit,'حد المحل',1,1000000),days=int(b.inactivity_days??30,'أيام الغياب',1,3650);
      if(old){need(uses>=old.uses,'الحد أقل من الاستخدام المحجوز');need(max===null||max>=old.used_quantity,'كمية العرض أقل من الكمية المحجوزة');}
      need(b.active===undefined||typeof b.active==='boolean','حالة غير صالحة');
      const values={listing_id:l.id,price:type==='fixed'?value:l.price,merchant_id:merchant,starts:new Date(start).toISOString(),ends:new Date(end).toISOString(),max_uses:uses,title:str(b.title||'عرض خاص','عنوان العرض',120),terms:typeof b.terms==='string'?b.terms.trim().slice(0,1000):'',active:b.active===false?0:1,audience,group_id:group,target_zone:zone,discount_type:type,discount_value:value,min_qty:min,max_quantity:max,per_merchant_limit:per,inactivity_days:days};
      const keys=Object.keys(values),args=Object.values(values);
      if(id)run(`UPDATE offers SET ${keys.map(k=>k+'=?').join(',')} WHERE id=?`,...args,id);
      else id=Number(run(`INSERT INTO offers(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`,...args).lastInsertRowid);
      audit(u,old?'offer.update':'offer.create',id);return {id};
    });
  }
  function groups(u){return all('SELECT * FROM offer_groups WHERE supplier_id=? ORDER BY id DESC',u.supplier_id).map(g=>({...g,merchant_ids:all('SELECT merchant_id FROM offer_group_members WHERE group_id=?',g.id).map(m=>m.merchant_id)}));}
  function saveGroup(u,b){return transaction(()=>{const name=str(b.name,'اسم المجموعة',120);need(Array.isArray(b.merchant_ids)&&b.merchant_ids.length>0&&b.merchant_ids.length<=200,'اختر من محل واحد حتى 200 محل');const ids=[...new Set(b.merchant_ids)];for(const id of ids)need(relationship(u.supplier_id,int(id,'المحل',1)),'أحد المحلات غير مرتبط بطلباتك');const id=Number(run('INSERT INTO offer_groups(supplier_id,name) VALUES(?,?)',u.supplier_id,name).lastInsertRowid);for(const mid of ids)run('INSERT INTO offer_group_members VALUES(?,?)',id,mid);audit(u,'offer_group.create',id);return {id};});}
  function reserve(id,quantity){need(run('UPDATE offers SET uses=uses+1,used_quantity=used_quantity+? WHERE id=? AND active=1 AND uses<max_uses AND (max_quantity IS NULL OR used_quantity+?<=max_quantity)',quantity,id,quantity).changes===1,'انتهت كمية العرض أو مرات الاستفادة',409);}
  function release(id,quantity){run('UPDATE offers SET uses=MAX(0,uses-1),used_quantity=MAX(0,used_quantity-?) WHERE id=?',quantity,id);}
  return {forListing,listing,save,groups,saveGroup,reserve,release};
}
