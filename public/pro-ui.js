// RAFID Pro Frontend: Business Intelligence, Native SVG Charts, Market Benchmarks & Subscriptions

window.proView = async function() {
  const sub = await api('/pro/subscription');
  const u = user;

  if (u.role === 'admin') {
    return renderAdminPro(sub);
  }

  if (!sub.is_pro) {
    return renderUpgradeShowcase(sub);
  }

  const days = window.proDays || 30;
  const data = await api(`/pro/overview?days=${days}`);

  if (u.role === 'supplier') {
    return renderSupplierPro(data, sub, days);
  }
  if (u.role === 'merchant') {
    return renderMerchantPro(data, sub, days);
  }
  return empty('لوحة التحليلات غير متاحة لهذا الدور');
};

function renderUpgradeShowcase(sub) {
  return heading('رافد برو | RAFID Pro', 'حوّل بياناتك التجارية اليومية إلى قرارات شراء ومبيعات مدروسة.') +
    `<div class="panel" style="text-align: center; padding: 40px 20px;">
      <span class="pill" style="font-size: 14px; padding: 6px 14px; background: #e8f5e9; color: #2e7d32;">★ النسخة الاحترافية للمنشآت والموردين</span>
      <h2 style="font-size: 26px; margin: 16px 0 8px;">ارتقِ بأعمالك مع ذكاء سوق الجملة</h2>
      <p class="muted" style="max-width: 600px; margin: 0 auto 24px;">
        تحليلات دقيقة للسوق في دمشق، رصد المنتجات الأسرع نمواً، تنبيهات فرص التوفير، وتحليلات أعمار الديون والتدفقات النقدية.
      </p>

      <div class="stats" style="max-width: 750px; margin: 0 auto 30px; text-align: right;">
        <div class="stat">
          <small>خطة الاشتراك</small>
          <strong>250,000 <small>ل.س / شهرياً</small></strong>
          <span class="tag">تفعيل فوري مع دعم مباشر</span>
        </div>
        <div class="stat">
          <small>حسابك الحالي</small>
          <strong>RAFID Free</strong>
          <span class="tag">الخطة الأساسية</span>
        </div>
      </div>

      <div class="panel table-wrap" style="max-width: 750px; margin: 0 auto 24px; text-align: right;">
        <table>
          <thead>
            <tr><th>الميزة</th><th>الحساب المجاني</th><th>RAFID Pro</th></tr>
          </thead>
          <tbody>
            <tr><td>تصفح المنتجات وسوق الجملة</td><td>✓</td><td>✓</td></tr>
            <tr><td>إنشاء ومتابعة الطلبات والفواتير</td><td>✓</td><td>✓</td></tr>
            <tr><td>تحليلات المنتجات الأكثر طلباً ومبيعاً</td><td>—</td><td>✓ (محدث لحظياً)</td></tr>
            <tr><td>الأصناف الأسرع نمواً ومعدلات التغير</td><td>—</td><td>✓ (مقارنة 7 و 30 يوماً)</td></tr>
            <tr><td>توزيع الطلب حسب مناطق دمشق</td><td>—</td><td>✓</td></tr>
            <tr><td>تنبيهات الأسعار وفرص التوفير الذكية</td><td>—</td><td>✓</td></tr>
            <tr><td>تصدير التقارير المتقدمة بصيغة CSV</td><td>—</td><td>✓</td></tr>
            <tr><td>مقارنة الأداء بمتوسط السوق</td><td>—</td><td>✓ (مع حماية الخصوصية)</td></tr>
          </tbody>
        </table>
      </div>

      <div class="form-actions" style="justify-content: center;">
        ${btn('طلب تفعيل RAFID Pro ←', 'pro-request-upgrade', '', 'orange')}
        ${config.demo ? btn('تفعيل تجريبي فوري (بيئة العرض)', 'pro-demo-activate', '', 'light') : ''}
      </div>
    </div>`;
}

function renderSvgBarChart(items, valueKey, labelKey, maxVal = null) {
  if (!items || !items.length) return '<p class="muted">لا توجد بيانات كافية للرسم</p>';
  const max = maxVal || Math.max(...items.map(i => i[valueKey] || 0), 1);
  const chartHeight = 160;
  const barWidth = Math.max(16, Math.min(36, Math.floor(400 / items.length)));
  const gap = 12;
  const totalWidth = items.length * (barWidth + gap);

  const bars = items.map((item, idx) => {
    const val = item[valueKey] || 0;
    const height = Math.round((val / max) * 120);
    const x = idx * (barWidth + gap) + 10;
    const y = chartHeight - height - 25;
    return `<g class="chart-bar" tabindex="0">
      <rect x="${x}" y="${y}" width="${barWidth}" height="${height}" rx="4" fill="#2d6a4f" opacity="0.9">
        <title>${esc(item[labelKey])}: ${val.toLocaleString('ar-SY')}</title>
      </rect>
      <text x="${x + barWidth / 2}" y="${y - 6}" font-size="10" text-anchor="middle" fill="#153b35" font-weight="bold">${val > 999 ? Math.round(val / 1000) + 'k' : val}</text>
      <text x="${x + barWidth / 2}" y="${chartHeight - 8}" font-size="9" text-anchor="middle" fill="#666">${esc(String(item[labelKey]).slice(0, 8))}</text>
    </g>`;
  }).join('');

  return `<div class="chart-container" style="overflow-x: auto; padding: 10px 0;">
    <svg viewBox="0 0 ${Math.max(totalWidth + 20, 300)} ${chartHeight}" style="width: 100%; max-height: ${chartHeight}px; font-family: inherit;">
      <line x1="0" y1="${chartHeight - 24}" x2="${Math.max(totalWidth + 20, 300)}" y2="${chartHeight - 24}" stroke="#ddd" stroke-width="1" />
      ${bars}
    </svg>
  </div>`;
}

function renderSupplierPro(data, sub, days) {
  const p = data.performance || {};
  const top = data.top_products || [];
  const growth = data.fast_growing || [];
  const regions = data.regions || [];
  const low = data.low_stock || [];
  const benchmark = data.market_benchmark || {};

  return heading('رافد برو | ذكاء السوق', 'تحليلات السوق في دمشق، رصد المنتجات، ومقارنة الأداء الفعلي.',
    `<div class="toolbar">
      <div class="chips">
        ${[7, 30, 90].map(d => `<button class="chip ${days === d ? 'active' : ''}" data-action="pro-filter-days" data-id="${d}">${d === 7 ? 'آخر أسبوع' : d === 30 ? 'آخر شهر' : '3 أشهر'}</button>`).join('')}
      </div>
      <a href="/api/pro/export?type=top_products" class="btn light small" download>📥 تصدير المبيعات CSV</a>
    </div>`
  ) +
    `<div class="stats">
      ${stat('إيرادات المبيعات المسلمة', money(p.revenue) + ' <small>ل.س</small>', (p.gmv_growth_percent >= 0 ? '+' : '') + p.gmv_growth_percent + '٪ عن الفترة السابقة')}
      ${stat('الطلبات المكتملة', money(p.delivered_orders), `من أصل ${p.total_orders} طلب`)}
      ${stat('متوسط قيمة الطلب', money(p.avg_order_value) + ' <small>ل.س</small>', 'لكل طلب مسلم')}
      ${stat('نسبة إتمام التوصيل', (p.completion_rate || 0) + '٪', `معدل الإلغاء: ${p.cancellation_rate || 0}٪`)}
    </div>

    <div class="split">
      <div class="panel">
        <div class="order-top">
          <h2>أكثر المنتجات مبيعاً</h2>
          <small>بالعبوات الموحدة</small>
        </div>
        ${renderSvgBarChart(top.slice(0, 8), 'units_sold', 'name')}
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>المنتج والعبوة</th><th>الكمية المباعة</th><th>إجمالي القيمة</th><th>متوسط السعر</th></tr>
            </thead>
            <tbody>
              ${top.slice(0, 10).map(i => `<tr>
                <td><strong>${esc(i.name)}</strong><br><small>${esc(i.brand)} · ${esc(i.pack)}</small></td>
                <td><strong>${money(i.units_sold)}</strong> عبوة</td>
                <td>${money(i.gmv)} ل.س</td>
                <td>${money(i.avg_price)} ل.س</td>
              </tr>`).join('')}
            </tbody>
          </table>
          ${!top.length ? empty('لا توجد مبيعات مكتملة بعد', 'ستظهر هنا المنتجات فور اكتمال توصيل الطلبات.') : ''}
        </div>
      </div>

      <div class="panel">
        <div class="order-top">
          <h2>المنتجات الأسرع نمواً</h2>
          <small>مقارنة آخر 7 أيام بالأيام السابقة</small>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>المنتج</th><th>مبيعات حديثة</th><th>نسبة النمو</th><th>مستوى الثقة</th></tr>
            </thead>
            <tbody>
              ${growth.map(g => `<tr>
                <td><strong>${esc(g.name)}</strong><br><small>${esc(g.pack)}</small></td>
                <td>${money(g.units_recent)}</td>
                <td><strong style="color: ${g.growth_rate >= 0 ? '#2e7d32' : '#c0392b'};">${g.growth_rate >= 0 ? '+' : ''}${g.growth_rate}٪</strong></td>
                <td><span class="pill">${g.confidence === 'high' ? 'عالية' : 'عينة صغيرة'}</span></td>
              </tr>`).join('')}
            </tbody>
          </table>
          ${!growth.length ? empty('بيانات غير كافية', 'يلزم نشاط مبيعات على مدى أسبوعين لحساب معدل النمو.') : ''}
        </div>

        <div class="order-top" style="margin-top: 24px;">
          <h2>توزيع الطلب حسب مناطق دمشق</h2>
          <small>المناطق الأكثر شراءً</small>
        </div>
        ${renderSvgBarChart(regions, 'gmv', 'zone')}
      </div>
    </div>

    <div class="split">
      <div class="panel">
        <h2>أصناف تقترب من نفاد المخزون</h2>
        <p class="muted">المنتجات التي يقل رصيدها عن 10 عبوات لتفادي خسارة المبيعات:</p>
        <div class="table-wrap">
          <table>
            <thead><tr><th>المنتج</th><th>المتبقي</th><th>السعر</th><th></th></tr></thead>
            <tbody>
              ${low.map(l => `<tr>
                <td><strong>${esc(l.name)}</strong><br><small>${esc(l.pack)}</small></td>
                <td><strong style="color: #c0392b;">${l.stock} عبوات</strong></td>
                <td>${money(l.price)} ل.س</td>
                <td>${btn('تحديث المخزون', 'nav', 'listings', 'small light')}</td>
              </tr>`).join('')}
            </tbody>
          </table>
          ${!low.length ? empty('المخزون بحالة جيدة', 'لا توجد أصناف منخفضة الرصيد حالياً.') : ''}
        </div>
      </div>

      <div class="panel">
        <h2>مؤشر السوق التجميعي (حماية الخصوصية)</h2>
        <p class="muted">مقارنة نمو الطلب العام في سوق دمشق بالجملة:</p>
        ${benchmark.sufficient_data ? `
          <div class="table-wrap">
            <table>
              <thead><tr><th>التصنيف</th><th>نمو الطلب في السوق</th></tr></thead>
              <tbody>
                ${benchmark.categories.map(c => `<tr>
                  <td><strong>${esc(c.category)}</strong></td>
                  <td><strong style="color: ${c.growth_percent >= 0 ? '#2e7d32' : '#c0392b'};">${c.growth_percent >= 0 ? '+' : ''}${c.growth_percent}٪</strong></td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
        ` : `
          <div class="notice">
            <strong>🔒 سياسة خصوصية المنافسين نشطة:</strong><br>
            ${esc(benchmark.message)}
          </div>
        `}
      </div>
    </div>`;
}

function renderMerchantPro(data, sub, days) {
  const s = data.summary || {};
  const top = data.top_purchased || [];
  const trends = data.wholesale_market_trends || [];
  const alerts = data.alerts || [];

  return heading('ذكاء مشترياتي | RAFID Pro', 'تحليل مشتريات محلك وتنبيهات فرص التوفير الذكية.',
    `<div class="toolbar">
      <a href="/api/pro/export?type=top_purchased" class="btn light small" download>📥 تصدير المشتريات CSV</a>
    </div>`
  ) +
    `<div class="stats">
      ${stat('إجمالي مشترياتك', money(s.total_spent) + ' <small>ل.س</small>', (s.spend_growth_percent >= 0 ? '+' : '') + s.spend_growth_percent + '٪ عن الشهر الماضي')}
      ${stat('عدد الطلبات المسلمة', money(s.orders_count), 'خلال الفترة')}
      ${stat('رسوم التوصيل المدفوعة', money(s.delivery_fees_paid) + ' <small>ل.س</small>', 'مجموع أجور الشحن')}
      ${stat('فرص التوفير النشطة', money(alerts.length), 'اقتراحات ذكية')}
    </div>

    ${alerts.length ? `
      <div class="panel">
        <h2>تنبيهات وفرص توفير ذكية</h2>
        <div class="stack">
          ${alerts.map(a => `
            <div class="notice" style="border-right-color: ${a.type === 'saving_opportunity' ? '#2e7d32' : '#e67e22'};">
              <strong>${esc(a.title)}</strong><br>
              ${esc(a.message)}
            </div>
          `).join('')}
        </div>
      </div>
    ` : ''}

    <div class="split">
      <div class="panel">
        <div class="order-top">
          <h2>أكثر المواد شراءً في متجرك</h2>
          <small>الأصناف الأكثر استهلاكاً</small>
        </div>
        ${renderSvgBarChart(top.slice(0, 6), 'total_spent', 'name')}
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>المنتج والعبوة</th><th>الكمية</th><th>إجمالي الإنفاق</th><th>متوسط سعر الشراء</th></tr>
            </thead>
            <tbody>
              ${top.map(i => `<tr>
                <td><strong>${esc(i.name)}</strong><br><small>${esc(i.brand)} · ${esc(i.pack)}</small></td>
                <td>${money(i.units_bought)}</td>
                <td><strong>${money(i.total_spent)} ل.س</strong></td>
                <td>${money(i.avg_unit_price)} ل.س</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <div class="panel">
        <div class="order-top">
          <h2>الأكثر طلباً بالجملة عبر رافد</h2>
          <small>الأصناف الرائجة في دمشق</small>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>المنتج والعبوة</th><th>التصنيف</th><th>إجمالي الطلبات</th></tr>
            </thead>
            <tbody>
              ${trends.map(t => `<tr>
                <td><strong>${esc(t.name)}</strong><br><small>${esc(t.pack)}</small></td>
                <td><span class="badge">${esc(t.category)}</span></td>
                <td><strong>${money(t.total_units_ordered)} عبوة</strong></td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
}

function renderAdminPro(sub) {
  return heading('إدارة اشتراكات رافد برو | RAFID Pro', 'إدارة المشتركين، تفعيل الاشتراكات المدفوعة خارجياً، ومراقبة أداء الميزة.') +
    `<div class="stats">
      ${stat('باقة Pro المتاحة', '250,000 ل.س / شهر', 'الخطة المدفوعة')}
      ${stat('الحالة الإدارية', 'متحكم كامل', 'صلاحيات ترقية الحسابات')}
    </div>
    <div class="panel">
      <h2>تفعيل أو تجديد اشتراك مدفوع لعميل</h2>
      <p class="muted">يتم تفعيل الاشتراك يدوياً بعد التحقق من استلام الرسوم أو إتاحة فترة تجريبية:</p>
      ${form('admin-subscription',
        select('نوع الحساب التجاري', 'entity_type', [
          ['merchant', 'صاحب محل (Merchant)'],
          ['supplier', 'مورد (Supplier)']
        ]) +
        field('معرف الحساب (ID)', 'entity_id', 'number', '', 'min="1" step="1"') +
        field('مدة الاشتراك بالأيام', 'duration_days', 'number', 30, 'min="1" max="3650" step="1"') +
        select('نوع التفعيل', 'plan_id', [
          ['pro', 'اشتراك رافد برو (RAFID Pro)'],
          ['free', 'إلغاء وإعادة للخطة المجانية']
        ]) +
        field('ملاحظات وإيصال السداد', 'notes', 'text', 'سداد نقدي مباشر للإدارة'),
        'حفظ وتفعيل الاشتراك'
      )}
    </div>`;
}

// Pro Actions
window.proAction = async function(action, id) {
  if (action === 'pro-filter-days') {
    window.proDays = Number(id);
    await load();
  }
  if (action === 'pro-request-upgrade') {
    modal('طلب الترقية إلى RAFID Pro', `
      <p>لتفعيل باقة رافد برو، يُرجى التواصل المباشر مع فريق العمليات والتسويات في رافد:</p>
      <div class="notice">
        <strong>هاتف العمليات:</strong> 011-9988776<br>
        <strong>رسوم الباقة:</strong> 250,000 ل.س / شهرياً<br>
        <strong>طرق السداد:</strong> تسليم نقدي لمندوب رافد أو حوالة بنكية معتمدة.
      </div>
      <div class="form-actions">${btn('حسناً', 'close', '', 'light')}</div>
    `);
  }
  if (action === 'pro-demo-activate') {
    const type = user.role === 'supplier' ? 'supplier' : 'merchant';
    const eid = user.role === 'supplier' ? user.supplier_id : user.id;
    await api('/admin/subscriptions', {
      entity_type: type,
      entity_id: eid,
      plan_id: 'pro',
      duration_days: 30,
      trial: true,
      notes: 'Demo instant activation'
    });
    toast('تم تفعيل باقة رافد برو لحسابك بنجاح!');
    await load();
  }
};
