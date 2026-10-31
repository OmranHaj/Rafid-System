const offerAudiences={all:'جميع المحلات',merchant:'محل محدد',group:'مجموعة محلات',zone:'منطقة محددة',first_order:'أول طلب من المورد',reactivation:'عميل متوقف عن الشراء'};
const offerStatuses={active:'نشط',paused:'موقوف',scheduled:'مجدول',expired:'منتهي',exhausted:'استُنفد'};
let supplierOffers=[],supplierGroups=[];
async function offersView(){
 [supplierOffers,supplierGroups]=await Promise.all([api('/offers'),api('/offer-groups')]);
 return heading('عروض تصل لأصحابها','حدد المستفيدين والكمية والمدة، وتابع الاستخدام.',btn('+ عرض جديد','new-offer'))+
 `<div class="stats">${stat('عروض نشطة',money(supplierOffers.filter(o=>o.status==='active').length))}${stat('مجدولة',money(supplierOffers.filter(o=>o.status==='scheduled').length))}${stat('مرات استفادة محجوزة',money(supplierOffers.reduce((s,o)=>s+o.uses,0)))}${stat('مجموعات العملاء',money(supplierGroups.length))}</div><div class="notice">يطبق أقل سعر مؤهل دون جمع الخصومات. الاستخدام ببند طلب، والكمية بوحدة العبوة؛ يُحرران عند الإلغاء أو الرفض. أول طلب وعودة العميل يحسبان لكل مورد.</div>
 <div class="panel table-wrap"><table><thead><tr><th>العرض / المنتج</th><th>الخصم والشروط</th><th>المستفيدون</th><th>الاستخدام</th><th>الحالة والمدة</th><th>الإدارة</th></tr></thead><tbody>${supplierOffers.map(o=>`<tr><td><strong>${esc(o.title)}</strong><br>${esc(o.name)}<br><small>${esc(o.pack)}</small></td><td>${o.discount_type==='percent'?money(o.discount_value)+'٪':o.discount_type==='amount'?'خصم '+money(o.discount_value)+' ل.س':'سعر '+money(o.discount_value??o.price)+' ل.س'}<br><small>من ${o.min_qty} عبوة${o.per_merchant_limit?' · '+o.per_merchant_limit+' مرات للمحل':''}</small><br><small>${esc(o.terms)}</small></td><td>${esc(offerAudiences[o.merchant_id?'merchant':o.audience])}${o.merchant_id?' #'+o.merchant_id:''}${o.group_name?'<br>'+esc(o.group_name):''}${o.target_zone?'<br>'+esc(o.target_zone):''}${o.audience==='reactivation'?'<br>غياب '+o.inactivity_days+' يومًا':''}</td><td>${o.uses} / ${o.max_uses} مرات<br><small>${o.used_quantity} / ${o.max_quantity??'بلا حد'} عبوة</small></td><td><span class="badge">${offerStatuses[o.status]}</span><br><small>${date(o.starts)}<br>${date(o.ends)}</small></td><td>${btn('تعديل','edit-offer',o.id,'light small')} ${btn(o.active?'إيقاف':'تفعيل','toggle-offer',o.id,o.active?'danger small':'light small')}</td></tr>`).join('')}</tbody></table>${supplierOffers.length?'':empty('لا توجد عروض بعد')}</div>
 <div class="section-label"><h2>مجموعات العملاء</h2>${btn('+ مجموعة محلات','new-group','','light')}</div><div class="grid">${supplierGroups.map(g=>`<div class="panel"><h3>${esc(g.name)}</h3><p class="muted">${g.merchant_ids.length} محلات من عملائك</p></div>`).join('')}</div>`;
}
function optionalOfferField(label,name,type,value,extra=''){return field(label,name,type,value,extra).replace(' required>','>');}
function audienceField(audience,html){return html.replace('<label>',`<label data-audience="${audience}">`);}
function offerPayload(b){return {...b,listing_id:Number(b.listing_id),merchant_id:b.merchant_id?Number(b.merchant_id):null,group_id:b.group_id?Number(b.group_id):null,discount_value:Number(b.discount_value),max_uses:Number(b.max_uses),min_qty:Number(b.min_qty),max_quantity:b.max_quantity?Number(b.max_quantity):null,per_merchant_limit:b.per_merchant_limit?Number(b.per_merchant_limit):null,inactivity_days:b.inactivity_days?Number(b.inactivity_days):30,starts:new Date(b.starts).toISOString(),ends:new Date(b.ends).toISOString(),active:b.active!=='0'};}
function syncOfferAudience(){const s=$('#offer [name="audience"]');if(!s)return;for(const label of document.querySelectorAll('#offer [data-audience]')){const enabled=label.dataset.audience===s.value;label.hidden=!enabled;for(const input of label.querySelectorAll('select,input'))input.disabled=!enabled;}}
async function offerAction(action,id){
 if(action==='new-group'){
  const merchants=await api('/merchants');if(!merchants.length)throw new Error('تظهر المحلات بعد تنفيذها طلبًا لدى متجرك؛ لا نكشف عملاء الموردين الآخرين.');
  modal('مجموعة محلات من عملائك',form('offer-group',field('اسم المجموعة','name')+`<div class="audience-list"><p class="muted">حدد المحلات المستفيدة</p>${merchants.map(m=>`<label class="checkline"><input type="checkbox" name="merchant_ids" value="${m.id}">${esc(m.name)}</label>`).join('')}</div>`,'إنشاء المجموعة'));return;
 }
 const o=id?supplierOffers.find(x=>x.id===Number(id)):null;
 if(action==='toggle-offer'){
  if(!o)throw new Error('حدّث قائمة العروض');if(!o.active&&Date.parse(o.ends)<=Date.now())throw new Error('عدّل نهاية العرض قبل إعادة تفعيله');
  await api('/offers/'+o.id,{...o,discount_value:o.discount_value??o.price,active:!o.active});toast(o.active?'أُوقف العرض للطلبات الجديدة':'تم التفعيل');await load();return;
 }
 const [listings,merchants,groups]=await Promise.all([api('/listings'),api('/merchants'),api('/offer-groups')]);
 if(!listings.length)throw new Error('أضف منتجًا وسعرًا إلى متجرك أولًا');
 const local=value=>new Date(Date.parse(value)-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16);
 modal(o?'تعديل العرض':'إنشاء عرض للمحل المناسب',form('offer',
  (o?`<input type="hidden" name="offer_id" value="${o.id}">`:'')+
  field('عنوان العرض','title','text',o?.title||'','maxlength="120"')+
  select('منتجك وعبوته','listing_id',listings.map(l=>[l.id,`${l.name} · ${l.pack}`]))+
  select('نوع الخصم','discount_type',[['fixed','سعر خاص للعبوة'],['percent','خصم بنسبة مئوية'],['amount','مبلغ خصم من سعر العبوة']])+
  field('السعر أو قيمة الخصم بحسب النوع','discount_value','number',o?.discount_value??o?.price??'','min="1" step="1"')+
  select('من يستفيد؟','audience',Object.entries(offerAudiences))+
  audienceField('merchant',select('المحل','merchant_id',[['','اختر محلًا'],...merchants.map(m=>[m.id,m.name])]))+
  audienceField('group',select('مجموعة المحلات','group_id',[['','أنشئ مجموعة من صفحة العروض أولًا'],...groups.map(g=>[g.id,g.name])]))+
  audienceField('zone',field('منطقة عنوان التوصيل المطابقة','target_zone','text',o?.target_zone||'دمشق'))+
  audienceField('reactivation',field('مرّ على آخر تسليم أكثر من (يوم)','inactivity_days','number',o?.inactivity_days||30,'min="1" max="3650" step="1"'))+
  field('الحد الأدنى للعبوات للاستفادة','min_qty','number',o?.min_qty||1,'min="1" step="1"')+
  field('أقصى مرات استفادة إجمالية','max_uses','number',o?.max_uses||100,'min="1" step="1"')+
  optionalOfferField('كمية العرض بالعبوات (فارغ: بلا حد)','max_quantity','number',o?.max_quantity??'','min="1" step="1"')+
  optionalOfferField('أقصى مرات لكل محل (فارغ: بلا حد)','per_merchant_limit','number',o?.per_merchant_limit??'','min="1" step="1"')+
  field('بداية العرض بتوقيت جهازك','starts','datetime-local',local(o?.starts||new Date().toISOString()))+
  field('نهاية العرض بتوقيت جهازك','ends','datetime-local',local(o?.ends||new Date(Date.now()+86400000).toISOString()))+
  `<label>شروط العرض<textarea name="terms" maxlength="1000" placeholder="شروط واضحة تظهر قبل التأكيد">${esc(o?.terms||'')}</textarea></label><input type="hidden" name="active" value="${o?.active===0?'0':'1'}">`,'حفظ العرض'));
 if(o){for(const name of ['listing_id','discount_type','audience','merchant_id','group_id']){const input=$('#offer [name="'+name+'"]');if(input)input.value=String(name==='audience'?(o.merchant_id?'merchant':o.audience):o[name]??'');}}
 syncOfferAudience();
}
