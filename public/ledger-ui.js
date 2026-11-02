// RAFID Ledger Frontend: Invoicing, Accounts Receivable, Driver Cash Custody, Aging & Statements

window.ledgerView = async function() {
  const u = user;
  if (u.role === 'merchant') {
    const stmt = await api('/ledger/statement');
    return renderMerchantLedger(stmt);
  }
  if (u.role === 'supplier') {
    const [aging, cols, rems] = await Promise.all([
      api('/ledger/aging'),
      api('/ledger/collections'),
      api('/ledger/remittances')
    ]);
    return renderSupplierLedger(aging, cols, rems);
  }
  if (u.role === 'driver') {
    const [cols, rems] = await Promise.all([
      api('/ledger/collections'),
      api('/ledger/remittances')
    ]);
    return renderDriverLedger(cols, rems);
  }
  if (u.role === 'admin') {
    const [cols, rems] = await Promise.all([
      api('/ledger/collections'),
      api('/ledger/remittances')
    ]);
    return renderAdminLedger(cols, rems);
  }
  return empty('لا توجد دفاتر مالية لهذا الدور');
};

function renderMerchantLedger(stmt) {
  const invs = stmt.invoices || [];
  const pays = stmt.payments || [];
  const isOverdue = stmt.overdue_balance > 0;

  return heading('دفتر حساباتي | RAFID Ledger', 'متابعة الفواتير والدفعات والمبالغ المستحقة لكل مورد بدقة وشفافية.') +
    (isOverdue ? `<div class="notice" style="border-right-color: #d9534f; background: #fff5f5;">
      <strong>⚠️ لديك فواتير متأخرة السداد</strong><br>
      المبلغ المتأخر: ${money(stmt.overdue_balance)} ل.س. يُرجى مراجعة المورد لتسديد الدفعات في موعدها.
    </div>` : '') +
    `<div class="stats">
      ${stat('إجمالي المشتريات المفوترة', money(stmt.total_invoiced) + ' <small>ل.س</small>', 'الفواتير الصادرة')}
      ${stat('إجمالي المدفوع', money(stmt.total_paid) + ' <small>ل.س</small>', 'دفعات نقدية وبنكية')}
      ${stat('الرصيد المستحق', money(stmt.outstanding_balance) + ' <small>ل.س</small>', 'بذمتك حالياً')}
      ${stat('المتأخر عن موعده', money(stmt.overdue_balance) + ' <small>ل.س</small>', isOverdue ? 'تجاوز مهلة السداد' : 'لا متأخرات')}
    </div>

    <div class="section-label">
      <h2>فواتيرك الرسمية</h2>
      <small>المرتبطة بالطلبات المستلمة وشروط الدفع</small>
    </div>

    <div class="panel table-wrap">
      <table>
        <thead>
          <tr>
            <th>رقم الفاتورة</th>
            <th>المورد</th>
            <th>تاريخ الاستحقاق</th>
            <th>القيمة</th>
            <th>المدفوع</th>
            <th>المتبقي</th>
            <th>شروط الدفع</th>
            <th>الحالة</th>
          </tr>
        </thead>
        <tbody>
          ${invs.map(i => {
            const due = i.total_amount - i.paid_amount;
            const termLabel = i.payment_terms === 'cod' ? 'عند الاستلام (COD)' : `آجل (${i.payment_terms.replace('net_', '')} يوم)`;
            const statusBadge = i.status === 'paid' ? '<span class="badge confirmed">مسددة</span>' :
              i.status === 'partially_paid' ? '<span class="badge in_transit">مدفوعة جزئياً</span>' :
              '<span class="badge pending">مستحقة</span>';
            return `<tr>
              <td><strong>${esc(i.invoice_number)}</strong><br><small>طلب فرعي #${i.suborder_id}</small></td>
              <td>${esc(i.supplier_name)}</td>
              <td>${esc(i.due_date)}</td>
              <td>${money(i.total_amount)} ل.س</td>
              <td>${money(i.paid_amount)} ل.س</td>
              <td><strong>${money(due)} ل.س</strong></td>
              <td><span class="pill">${esc(termLabel)}</span></td>
              <td>${statusBadge}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      ${!invs.length ? empty('لا توجد فواتير صادرة بعد', 'تصدر الفواتير آلياً فور استلام الطلب وتأكيد الاستلام.') : ''}
    </div>

    <div class="section-label">
      <h2>سجل المدفوعات والإيصالات</h2>
      <small>المبالغ المسجلة والمسددة لكل مورد</small>
    </div>

    <div class="panel table-wrap">
      <table>
        <thead>
          <tr>
            <th>رقم الإيصال</th>
            <th>المورد</th>
            <th>التاريخ</th>
            <th>المبلغ</th>
            <th>طريقة الدفع</th>
            <th>البيان</th>
          </tr>
        </thead>
        <tbody>
          ${pays.map(p => `<tr>
            <td><strong>${esc(p.receipt_number)}</strong></td>
            <td>${esc(p.supplier_name)}</td>
            <td>${date(p.created)}</td>
            <td><strong>${money(p.amount)} ل.س</strong></td>
            <td><span class="badge">${p.payment_method === 'cash' ? 'نقداً' : p.payment_method === 'bank_transfer' ? 'حوالة بنكية' : p.payment_method === 'sham_cash' ? 'شام كاش (تجريبي)' : esc(p.payment_method)}</span></td>
            <td>${esc(p.memo || '—')}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      ${!pays.length ? empty('لا توجد دفعات مسجلة بعد', 'تظهر هنا الإيصالات النقدية والتحويلات المعتمدة.') : ''}
    </div>`;
}

function renderSupplierLedger(aging, cols, rems) {
  const b = aging.buckets || {};
  const delinq = aging.delinquent_merchants || [];
  const invs = aging.invoices || [];

  return heading('الذمم والتحصيلات | RAFID Ledger', 'متابعة أعمار الديون، سداد الفواتير، ومطابقة عهد السائقين بدقة.', btn('+ تسجيل دفعة يدوية', 'ledger-new-payment', '', 'orange')) +
    `<div class="stats">
      ${stat('إجمالي المستحقات من المحلات', money(aging.total_receivables) + ' <small>ل.س</small>', 'ذمم قائمة')}
      ${stat('مجموع المبالغ المتأخرة', money(aging.overdue_receivables) + ' <small>ل.س</small>', 'تجاوزت تاريخ الاستحقاق')}
      ${stat('فواتير غير مسددة', money(invs.length), 'تحتاج متابعة')}
      ${stat('عملاء لديهم متأخرات', money(delinq.length), 'محلات متأخرة بالسداد')}
    </div>

    <div class="panel">
      <h2>أعمار الذمم والديون (Aging Analysis)</h2>
      <p class="muted">توزيع المبالغ غير المسددة حسب عدد أيام التأخير عن موعد الاستحقاق:</p>
      <div class="stats" style="grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));">
        <div class="stat"><small>حالية (ضمن المهلة)</small><strong>${money(b.current || 0)}</strong><small>ل.س</small></div>
        <div class="stat"><small>متأخرة 1–7 أيام</small><strong style="color: #e67e22;">${money(b.days_1_7 || 0)}</strong><small>ل.س</small></div>
        <div class="stat"><small>متأخرة 8–15 يوماً</small><strong style="color: #d35400;">${money(b.days_8_15 || 0)}</strong><small>ل.س</small></div>
        <div class="stat"><small>متأخرة 16–30 يوماً</small><strong style="color: #c0392b;">${money(b.days_16_30 || 0)}</strong><small>ل.س</small></div>
        <div class="stat"><small>أكثر من 30 يوماً</small><strong style="color: #8b0000;">${money(b.days_30_plus || 0)}</strong><small>ل.س</small></div>
      </div>
    </div>

    ${delinq.length ? `<div class="panel">
      <h2>أكثر العملاء تأخراً بالسداد</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>المحل</th><th>المبلغ المتأخر</th><th>عدد الفواتير</th><th>إجراء</th></tr>
          </thead>
          <tbody>
            ${delinq.map(m => `<tr>
              <td><strong>${esc(m.name)}</strong></td>
              <td><strong style="color: #c0392b;">${money(m.overdue)} ل.س</strong></td>
              <td>${m.invoices_count}</td>
              <td>${btn('ضبط سقف الذمم', 'ledger-credit-terms', m.merchant_id, 'light small')}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>` : ''}

    <div class="split">
      <div class="panel">
        <div class="order-top">
          <h2>الفواتير غير المسددة</h2>
          <span>${invs.length} فواتير</span>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>الفاتورة</th><th>المحل</th><th>الاستحقاق</th><th>المتبقي</th></tr>
            </thead>
            <tbody>
              ${invs.slice(0, 15).map(i => `<tr>
                <td><strong>${esc(i.invoice_number)}</strong></td>
                <td>${esc(i.merchant_name)}</td>
                <td>${esc(i.due_date)}</td>
                <td><strong>${money(i.total_amount - i.paid_amount)} ل.س</strong></td>
              </tr>`).join('')}
            </tbody>
          </table>
          ${!invs.length ? empty('لا توجد فواتير متأخرة', 'جميع الفواتير مسددة بالكامل.') : ''}
        </div>
      </div>

      <div class="panel">
        <div class="order-top">
          <h2>مطابقة توريدات السائقين</h2>
          <span>${rems.length} إشعار توريد</span>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>رقم الإشعار</th><th>السائق</th><th>المبلغ</th><th>الحالة</th><th></th></tr>
            </thead>
            <tbody>
              ${rems.map(r => `<tr>
                <td><strong>${esc(r.remittance_number)}</strong></td>
                <td>${esc(r.driver_name)}</td>
                <td>${money(r.amount)} ل.س</td>
                <td><span class="badge ${r.status === 'verified' ? 'confirmed' : r.status === 'disputed' ? 'failed' : 'pending'}">${r.status === 'verified' ? 'معتمد' : r.status === 'disputed' ? 'نزاع/فرق' : 'بانتظار الاعتماد'}</span></td>
                <td>${r.status === 'submitted' ? btn('اعتماد التوريد', 'ledger-reconcile-modal', r.id, 'small light') : '—'}</td>
              </tr>`).join('')}
            </tbody>
          </table>
          ${!rems.length ? empty('لا توجد توريدات نقدية معلقة', 'تظهر هنا إشعارات توريد النقد الواردة من السائقين.') : ''}
        </div>
      </div>
    </div>`;
}

function renderDriverLedger(cols, rems) {
  const totalCollected = cols.reduce((a, c) => a + c.collected_amount, 0);
  const totalRemitted = rems.filter(r => r.status === 'verified').reduce((a, r) => a + r.amount, 0);
  const pendingRemit = cols.filter(c => ['collected', 'pending_remittance', 'partially_remitted'].includes(c.remittance_status))
    .reduce((a, c) => a + (c.collected_amount - c.remitted_amount), 0);

  return heading('عهد النقد والتحصيلات', 'سجل المبالغ النقدية المحصلة عند التسليم، وإثبات توريدها للمورد.', btn('+ إرسال إشعار توريد نقد', 'ledger-new-remit', '', 'orange')) +
    `<div class="stats">
      ${stat('النقد المحصل إجمالاً', money(totalCollected) + ' <small>ل.س</small>', 'من جميع رحلاتك')}
      ${stat('النقد المورد والمعتمد', money(totalRemitted) + ' <small>ل.س</small>', 'تم استلامه رسمياً')}
      ${stat('العهدة النقدية بحوزتك', money(pendingRemit) + ' <small>ل.س</small>', 'يلزم توريدها')}
    </div>

    <div class="panel table-wrap">
      <h2>سجل المبالغ المحصلة من المحلات</h2>
      <table>
        <thead>
          <tr><th>الطلب</th><th>المحل</th><th>المورد</th><th>المبلغ المحصل</th><th>حالة العهدة</th></tr>
        </thead>
        <tbody>
          ${cols.map(c => `<tr>
            <td><strong>طلب فرعي #${c.suborder_id}</strong></td>
            <td>${esc(c.merchant_name)}</td>
            <td>${esc(c.supplier_name)}</td>
            <td><strong>${money(c.collected_amount)} ل.س</strong></td>
            <td><span class="badge ${c.remittance_status === 'reconciled' ? 'confirmed' : 'pending'}">${c.remittance_status === 'reconciled' ? 'موردة بالكامل' : 'عهدة معلقة'}</span></td>
          </tr>`).join('')}
        </tbody>
      </table>
      ${!cols.length ? empty('لا توجد مبالغ محصلة بعد', 'عند تسليم الطلبات واستلام النقد ستسجل العهدة هنا.') : ''}
    </div>

    <div class="panel table-wrap">
      <h2>سجل إشعارات التوريد</h2>
      <table>
        <thead>
          <tr><th>رقم الإشعار</th><th>التاريخ</th><th>المبلغ المورد</th><th>الحالة</th><th>ملاحظة</th></tr>
        </thead>
        <tbody>
          ${rems.map(r => `<tr>
            <td><strong>${esc(r.remittance_number)}</strong></td>
            <td>${date(r.created)}</td>
            <td>${money(r.amount)} ل.س</td>
            <td><span class="badge ${r.status === 'verified' ? 'confirmed' : 'pending'}">${r.status === 'verified' ? 'تمت المطابقة' : 'قيد المراجعة'}</span></td>
            <td>${esc(r.note || '—')}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      ${!rems.length ? empty('لم تقم بتوريد نقد بعد', 'استخدم زر إرسال إشعار توريد عند تسليم النقد للمستودع أو الإدارة.') : ''}
    </div>`;
}

function renderAdminLedger(cols, rems) {
  const totalCollections = cols.reduce((a, c) => a + c.collected_amount, 0);
  const pendingCollections = cols.filter(c => c.remittance_status !== 'reconciled').reduce((a, c) => a + (c.collected_amount - c.remitted_amount), 0);

  return heading('المطابقة المالية والذمم | RAFID Ledger', 'مراقبة العهد النقدية، تسوية التحصيلات بين أسطول رافد والموردين، والرقابة المحاسبية.') +
    `<div class="stats">
      ${stat('إجمالي النقد المحصل', money(totalCollections) + ' <small>ل.س</small>', 'عبر جميع السائقين')}
      ${stat('عهد نقدية قيد التوريد', money(pendingCollections) + ' <small>ل.س</small>', 'بحوزة السائقين حالياً')}
      ${stat('إشعارات التوريد', money(rems.length), 'سجل التوريدات')}
    </div>

    <div class="panel table-wrap">
      <h2>إشعارات التوريد والمطابقة</h2>
      <table>
        <thead>
          <tr><th>رقم الإشعار</th><th>السائق</th><th>المستلم</th><th>المبلغ</th><th>الحالة</th><th></th></tr>
        </thead>
        <tbody>
          ${rems.map(r => `<tr>
            <td><strong>${esc(r.remittance_number)}</strong></td>
            <td>${esc(r.driver_name)}</td>
            <td>${r.receiver_role === 'supplier' ? 'المورد' : 'إدارة رافد'}</td>
            <td>${money(r.amount)} ل.س</td>
            <td><span class="badge ${r.status === 'verified' ? 'confirmed' : 'pending'}">${r.status === 'verified' ? 'معتمد' : 'بانتظار الاعتماد'}</span></td>
            <td>${r.status === 'submitted' && r.receiver_role === 'admin' ? btn('اعتماد التوريد', 'ledger-reconcile-modal', r.id, 'small light') : '—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

const commissionRate = bps => (bps / 100).toLocaleString('ar-SY') + '٪';
const shamNotice = '<div class="notice sham-notice"><strong>شام كاش · محاكاة للعرض</strong><br>لا تُنقل أي أموال حقيقية ولا ترتبط هذه الشاشة بخدمة شام كاش الفعلية.</div>';
const walletField = () => field('رقم محفظة شام كاش', 'wallet', 'tel', '', 'inputmode="numeric" pattern="09[0-9]{8}" maxlength="10" dir="ltr" placeholder="09XXXXXXXX"');

window.commissionsView = async function() {
  const data = await api('/commissions');
  return user.role === 'supplier' ? renderSupplierCommissions(data) : renderAdminCommissions(data);
};

function renderSupplierCommissions(a) {
  return heading('حسابي مع رافد', `تحتسب رافد ${commissionRate(a.rate_bps)} من قيمة كل فاتورة بعد تسليم الطلب.`, a.due_commission > 0 && config.demo ? btn('تسديد المستحق عبر شام كاش', 'ledger-settle-commission', a.due_commission, 'sham') : '') +
    `<div class="stats">
      ${stat('إجمالي المبيعات', money(a.total_sales) + ' <small>ل.س</small>', `${money(a.invoices_count)} فاتورة`)}
      ${stat('ما أخذته المنصة', money(a.settled_commission) + ' <small>ل.س</small>', `من أصل ${money(a.total_commission)} ل.س عمولة`)}
      ${stat('المستحق لرافد', money(a.due_commission) + ' <small>ل.س</small>', 'من طلبات النقد')}
      ${stat('صافي مبيعاتك', money(a.net_sales) + ' <small>ل.س</small>', 'بعد العمولة')}
    </div>

    <div class="section-label">
      <h2>تفاصيل العمولة لكل فاتورة</h2>
      <small>النسبة محفوظة مع الفاتورة وقت إصدارها</small>
    </div>

    <div class="panel table-wrap">
      <table>
        <thead>
          <tr><th>الفاتورة</th><th>المحل</th><th>التاريخ</th><th>قيمة الفاتورة</th><th>النسبة</th><th>العمولة</th><th>الحالة</th></tr>
        </thead>
        <tbody>
          ${a.rows.map(c => `<tr>
            <td><strong>${esc(c.invoice_number)}</strong><br><small>طلب فرعي #${c.suborder_id}</small></td>
            <td>${esc(c.merchant_name)}</td>
            <td>${esc(c.issue_date)}</td>
            <td>${money(c.invoice_amount)} ل.س</td>
            <td>${commissionRate(c.rate_bps)}</td>
            <td><strong>${money(c.amount)} ل.س</strong></td>
            <td><span class="badge ${c.status === 'settled' ? 'verified' : 'pending'}">${c.status === 'due' ? 'مستحقة' : c.settled_via === 'deducted' ? 'خُصمت من دفعة شام كاش' : 'سُددت عبر شام كاش'}</span></td>
          </tr>`).join('')}
        </tbody>
      </table>
      ${!a.rows.length ? empty('لا توجد عمولات بعد', 'تظهر هنا عمولة كل فاتورة فور تسليم الطلب.') : ''}
    </div>`;
}

function renderAdminCommissions(o) {
  return heading('عمولات المنصة', `إيراد رافد بنسبة ${commissionRate(o.rate_bps)} من الفواتير المسلّمة لكل مورد.`) +
    `<div class="stats">
      ${stat('قيمة الفواتير المسلّمة', money(o.total_sales) + ' <small>ل.س</small>', 'كل الموردين')}
      ${stat('إجمالي العمولات', money(o.total_commission) + ' <small>ل.س</small>', commissionRate(o.rate_bps))}
      ${stat('المستلم فعلياً', money(o.settled_commission) + ' <small>ل.س</small>', 'خصم وتسديد')}
      ${stat('المستحق على الموردين', money(o.due_commission) + ' <small>ل.س</small>', 'من طلبات النقد')}
    </div>

    <div class="panel table-wrap">
      <h2>العمولات حسب المورد</h2>
      <table>
        <thead>
          <tr><th>المورد</th><th>الفواتير</th><th>المبيعات</th><th>العمولة</th><th>المستحق</th></tr>
        </thead>
        <tbody>
          ${o.suppliers.map(s => `<tr>
            <td><strong>${esc(s.name)}</strong></td>
            <td>${money(s.invoices_count)}</td>
            <td>${money(s.total_sales)} ل.س</td>
            <td><strong>${money(s.total_commission)} ل.س</strong></td>
            <td>${money(s.due_commission)} ل.س</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

// Modal actions for Ledger
window.ledgerAction = async function(action, id) {
  if (action === 'ledger-sham-checkout') {
    if (!quote) throw new Error('راجع السلة أولًا');
    modal('الدفع عبر شام كاش', shamNotice + form('sham-checkout',
      `<p>إجمالي الطلب <strong>${money(quote.total)} ل.س</strong><br><small>يُفوّض المبلغ الآن ويُخصم عند التسليم فقط، ولا يُخصم شيء إن رُفض الطلب أو أُلغي.</small></p>` +
      walletField(),
      'تفويض الدفع وتأكيد الطلب'
    ));
  }

  if (action === 'ledger-settle-commission') {
    modal('تسديد عمولة رافد', shamNotice + form('sham-settle',
      `<input type="hidden" name="amount" value="${id}">
      <p>المبلغ المستحق <strong>${money(id)} ل.س</strong></p>` +
      walletField(),
      'تسديد المبلغ'
    ));
  }

  if (action === 'ledger-new-payment') {
    const merchants = await api('/merchants');
    modal('تسجيل دفعة يدوية', form('ledger-payment',
      select('المحل المسدد', 'merchant_id', merchants.map(m => [m.id, m.name])) +
      field('المبلغ المسدد · ل.س', 'amount', 'number', '', 'min="1" step="1"') +
      select('طريقة السداد', 'payment_method', [
        ['cash', 'نقداً'],
        ['bank_transfer', 'حوالة بنكية'],
        ['settlement_credit', 'تسوية رصيد دائن'],
        ['manual_adjustment', 'تسوية إدارية']
      ]) +
      field('البيان وتفاصيل الدفعة', 'memo', 'text', 'دفعة نقدية مسددة'),
      'تسجيل الدفعة'
    ));
  }

  if (action === 'ledger-credit-terms') {
    const terms = await api(`/ledger/credit-terms?merchant_id=${id}`);
    modal('تحديد سقف الائتمان والمهلة', form('ledger-terms',
      `<input type="hidden" name="merchant_id" value="${id}">` +
      field('سقف الذمم المسموح · ل.س (0 يعني غير محدد)', 'credit_limit', 'number', terms.credit_limit || 0, 'min="0" step="1"') +
      field('مهلة السداد بالأيام (0 = نقداً عند الاستلام)', 'payment_term_days', 'number', terms.payment_term_days || 0, 'min="0" max="365" step="1"') +
      field('شروط وملاحظات الاتفاق', 'notes', 'text', terms.notes || ''),
      'حفظ الشروط'
    ));
  }

  if (action === 'ledger-new-remit') {
    modal('إرسال إشعار توريد نقد', form('ledger-remit',
      field('المبلغ المراد توريده نقدياً · ل.س', 'amount', 'number', '', 'min="1" step="1"') +
      field('ملاحظات وتفاصيل التسليم', 'note', 'text', 'تسليم نقد عهدة للمستودع'),
      'تأكيد التوريد'
    ));
  }

  if (action === 'ledger-reconcile-modal') {
    modal('اعتماد ومطابقة توريد النقد', form('ledger-reconcile',
      `<input type="hidden" name="remittance_id" value="${id}">` +
      field('المبلغ الفعلي المستلم بعد العد والتحقق · ل.س', 'verified_amount', 'number', '', 'min="0" step="1"') +
      field('قرار المطابقة / ملاحظة الفروقات إن وجدت', 'note', 'text', 'مستلم ومطابق بالكامل'),
      'اعتماد التسوية'
    ));
  }
};
