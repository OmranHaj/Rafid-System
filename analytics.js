// RAFID Pro: Business Intelligence, Market Analytics & Subscriptions Engine.

export function createAnalyticsEngine({ db, need, int, str, fail, transaction, audit, now }) {
  const one = (s, ...a) => db.prepare(s).get(...a);
  const all = (s, ...a) => db.prepare(s).all(...a);
  const run = (s, ...a) => db.prepare(s).run(...a);

  // 1. Schema migrations for Subscriptions and Aggregates
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscription_plans(
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price INTEGER NOT NULL DEFAULT 0 CHECK(price >= 0),
      billing_interval TEXT NOT NULL DEFAULT 'month',
      description TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS subscriptions(
      id INTEGER PRIMARY KEY,
      entity_type TEXT NOT NULL CHECK(entity_type IN ('merchant','supplier')),
      entity_id INTEGER NOT NULL,
      plan_id TEXT NOT NULL REFERENCES subscription_plans(id),
      status TEXT NOT NULL CHECK(status IN ('active','trialing','expired','cancelled')),
      trial_ends TEXT,
      starts_at TEXT NOT NULL,
      ends_at TEXT,
      renewed_at TEXT,
      activated_by INTEGER REFERENCES users(id),
      notes TEXT NOT NULL DEFAULT '',
      created TEXT NOT NULL,
      updated TEXT NOT NULL,
      UNIQUE(entity_type, entity_id)
    );

    CREATE TABLE IF NOT EXISTS subscription_events(
      id INTEGER PRIMARY KEY,
      subscription_id INTEGER NOT NULL REFERENCES subscriptions(id),
      actor_id INTEGER NOT NULL REFERENCES users(id),
      action TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      created TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daily_product_stats(
      id INTEGER PRIMARY KEY,
      stat_date TEXT NOT NULL,
      product_id INTEGER NOT NULL REFERENCES products(id),
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      units_sold INTEGER NOT NULL DEFAULT 0,
      orders_count INTEGER NOT NULL DEFAULT 0,
      gmv INTEGER NOT NULL DEFAULT 0,
      avg_price INTEGER NOT NULL DEFAULT 0,
      UNIQUE(stat_date, product_id, supplier_id)
    );

    CREATE TABLE IF NOT EXISTS daily_region_stats(
      id INTEGER PRIMARY KEY,
      stat_date TEXT NOT NULL,
      zone TEXT NOT NULL,
      orders_count INTEGER NOT NULL DEFAULT 0,
      gmv INTEGER NOT NULL DEFAULT 0,
      UNIQUE(stat_date, zone)
    );

    CREATE TABLE IF NOT EXISTS analytics_refresh_state(
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated TEXT NOT NULL
    );
  `);

  // 2. Seed Default Plans
  const defaultPlans = [
    ['free', 'RAFID Free', 0, 'month', 'الخطة الأساسية: تصفح الدليل والطلب ومتابعة الفواتير الأساسية'],
    ['pro', 'RAFID Pro', 250000, 'month', 'باقة رافد برو: ذكاء السوق والتحليلات المتقدمة واتجاهات المنتجات والتقارير المالية']
  ];

  for (const [id, name, price, interval, desc] of defaultPlans) {
    if (!one('SELECT id FROM subscription_plans WHERE id=?', id)) {
      run('INSERT INTO subscription_plans(id, name, price, billing_interval, description) VALUES(?,?,?,?,?)', id, name, price, interval, desc);
    }
  }

  // 3. Subscription Management & RBAC Verification
  function getSubscription(entityType, entityId) {
    const sub = one('SELECT s.*, p.name as plan_name, p.price as plan_price FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id WHERE s.entity_type=? AND s.entity_id=?', entityType, entityId);
    if (!sub) {
      return {
        entity_type: entityType,
        entity_id: entityId,
        plan_id: 'free',
        plan_name: 'RAFID Free',
        status: 'active',
        is_pro: false
      };
    }

    const isExpired = sub.ends_at && Date.parse(sub.ends_at) < Date.now();
    const isPro = (sub.plan_id === 'pro') && ['active', 'trialing'].includes(sub.status) && !isExpired;
    return {
      ...sub,
      is_pro: isPro,
      status: isExpired ? 'expired' : sub.status
    };
  }

  function hasProAccess(u) {
    if (!u) return false;
    if (u.role === 'admin') return true;
    if (u.role === 'supplier') {
      const sub = getSubscription('supplier', u.supplier_id);
      return sub.is_pro;
    }
    if (u.role === 'merchant') {
      const sub = getSubscription('merchant', u.id);
      return sub.is_pro;
    }
    return false;
  }

  function requirePro(u) {
    need(hasProAccess(u), 'هذه الميزة تتطلب اشتراك رافد برو (RAFID Pro) مفعل', 403);
  }

  function activateSubscription(adminUser, b) {
    return transaction(() => {
      need(adminUser.role === 'admin', 'صلاحية الإدارة مطلوبة لتفعيل الاشتراك', 403);
      const entityType = str(b.entity_type, 'نوع الحساب', 20);
      need(['merchant', 'supplier'].includes(entityType), 'نوع الحساب غير صالح');
      const entityId = int(b.entity_id, 'معرف الحساب', 1);
      const planId = str(b.plan_id || 'pro', 'الخطة', 20);
      need(one('SELECT id FROM subscription_plans WHERE id=?', planId), 'الخطة غير موجودة');

      const days = int(b.duration_days || 30, 'مدة الاشتراك بالأيام', 1, 3650);
      const isTrial = b.trial === true;
      const status = isTrial ? 'trialing' : 'active';
      const startsAt = now();
      const endsAt = new Date(Date.now() + days * 86400000).toISOString();
      const notes = str(b.notes || 'تفعيل اشتراك معتمد', 'الملاحظات', 300);

      const res = run(
        `INSERT INTO subscriptions(entity_type, entity_id, plan_id, status, trial_ends, starts_at, ends_at, renewed_at, activated_by, notes, created, updated)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(entity_type, entity_id) DO UPDATE SET plan_id=excluded.plan_id, status=excluded.status, trial_ends=excluded.trial_ends, starts_at=excluded.starts_at, ends_at=excluded.ends_at, renewed_at=excluded.renewed_at, activated_by=excluded.activated_by, notes=excluded.notes, updated=excluded.updated`,
        entityType,
        entityId,
        planId,
        status,
        isTrial ? endsAt : null,
        startsAt,
        endsAt,
        startsAt,
        adminUser.id,
        notes,
        now(),
        now()
      );

      const subRow = one('SELECT * FROM subscriptions WHERE entity_type=? AND entity_id=?', entityType, entityId);
      run('INSERT INTO subscription_events(subscription_id, actor_id, action, details, created) VALUES(?,?,?,?,?)', subRow.id, adminUser.id, 'activate', `تفعيل خطة ${planId} لمدة ${days} يوماً`, now());

      audit(adminUser, 'subscription.activate', `${entityType}:${entityId}`);
      return subRow;
    });
  }

  function cancelSubscription(adminUser, b) {
    return transaction(() => {
      need(adminUser.role === 'admin', 'صلاحية الإدارة مطلوبة', 403);
      const subId = int(b.subscription_id, 'الاشتراك', 1);
      const sub = one('SELECT * FROM subscriptions WHERE id=?', subId);
      need(sub, 'الاشتراك غير موجود', 404);

      const reason = str(b.reason || 'إلغاء بناء على طلب العميل أو انتهاء السداد', 'سبب الإلغاء', 300);
      run("UPDATE subscriptions SET status='cancelled', updated=? WHERE id=?", now(), sub.id);
      run('INSERT INTO subscription_events(subscription_id, actor_id, action, details, created) VALUES(?,?,?,?,?)', sub.id, adminUser.id, 'cancel', reason, now());

      audit(adminUser, 'subscription.cancel', sub.id);
      return { ok: true };
    });
  }

  // 4. Damascus Local Date Helper
  function getDamascusDate(isoDateStr = null) {
    const d = isoDateStr ? new Date(isoDateStr) : new Date();
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Damascus',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).formatToParts(d).map(p => [p.type, p.value])
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  // 5. Daily Aggregation Engine
  function refreshAggregates() {
    return transaction(() => {
      // Clear and re-aggregate delivered orders to ensure idempotency and handle returns/corrections
      run('DELETE FROM daily_product_stats');
      run('DELETE FROM daily_region_stats');

      // Aggregate product sales per day & supplier
      const productStats = all(`
        SELECT
          substr(COALESCE(NULLIF(s.delivery_date, ''), o.created), 1, 10) as stat_date,
          i.product_id,
          s.supplier_id,
          SUM(i.quantity) as units_sold,
          COUNT(DISTINCT s.id) as orders_count,
          SUM(i.quantity * i.price) as gmv,
          ROUND(AVG(i.price)) as avg_price
        FROM order_items i
        JOIN suborders s ON s.id = i.suborder_id
        JOIN orders o ON o.id = s.order_id
        WHERE s.status = 'delivered'
        GROUP BY stat_date, i.product_id, s.supplier_id
      `);

      for (const row of productStats) {
        if (!row.stat_date) continue;
        run(
          `INSERT INTO daily_product_stats(stat_date, product_id, supplier_id, units_sold, orders_count, gmv, avg_price)
           VALUES(?,?,?,?,?,?,?)`,
          row.stat_date,
          row.product_id,
          row.supplier_id,
          row.units_sold,
          row.orders_count,
          row.gmv,
          Math.round(row.avg_price || 0)
        );
      }

      // Aggregate regional demand per day
      const regionStats = all(`
        SELECT
          substr(COALESCE(NULLIF(s.delivery_date, ''), o.created), 1, 10) as stat_date,
          o.zone,
          COUNT(DISTINCT s.id) as orders_count,
          SUM(s.total) as gmv
        FROM suborders s
        JOIN orders o ON o.id = s.order_id
        WHERE s.status = 'delivered'
        GROUP BY stat_date, o.zone
      `);

      for (const row of regionStats) {
        if (!row.stat_date) continue;
        run(
          `INSERT INTO daily_region_stats(stat_date, zone, orders_count, gmv)
           VALUES(?,?,?,?)`,
          row.stat_date,
          row.zone,
          row.orders_count,
          row.gmv
        );
      }

      run(
        `INSERT INTO analytics_refresh_state(key, value, updated)
         VALUES('last_refresh', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated=excluded.updated`,
        now(),
        now()
      );

      return { ok: true, refreshed_at: now() };
    });
  }

  // 6. Supplier Pro Analytics (Market Intelligence & Performance)
  const MIN_AGGREGATION_THRESHOLD = 5; // Protect competitor privacy: require >= 5 independent suppliers

  function getSupplierProOverview(supplierId, filters = {}) {
    const days = int(filters.days || 30, 'الأيام', 1, 365);
    const startDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const prevStartDate = new Date(Date.now() - days * 2 * 86400000).toISOString().slice(0, 10);

    // Personal Supplier Performance
    const currentOrders = all(
      `SELECT s.*, o.created as order_created, o.zone FROM suborders s JOIN orders o ON o.id=s.order_id WHERE s.supplier_id=? AND o.created >= ?`,
      supplierId,
      startDate
    );

    const prevOrders = all(
      `SELECT s.* FROM suborders s JOIN orders o ON o.id=s.order_id WHERE s.supplier_id=? AND o.created >= ? AND o.created < ?`,
      supplierId,
      prevStartDate,
      startDate
    );

    const deliveredCurrent = currentOrders.filter(s => s.status === 'delivered');
    const deliveredPrev = prevOrders.filter(s => s.status === 'delivered');

    const revenueCurrent = deliveredCurrent.reduce((a, s) => a + (s.total - s.fee), 0);
    const revenuePrev = deliveredPrev.reduce((a, s) => a + (s.total - s.fee), 0);
    const gmvGrowth = revenuePrev > 0 ? Math.round(((revenueCurrent - revenuePrev) / revenuePrev) * 100) : (revenueCurrent > 0 ? 100 : 0);

    const cancelledCount = currentOrders.filter(s => s.status === 'cancelled' || s.status === 'rejected').length;
    const cancellationRate = currentOrders.length > 0 ? Math.round((cancelledCount / currentOrders.length) * 100) : 0;
    const completionRate = currentOrders.length > 0 ? Math.round((deliveredCurrent.length / currentOrders.length) * 100) : 0;

    // Top Selling Products (Aggregated by Unified Product identity & Pack)
    const topProducts = all(`
      SELECT
        p.id as product_id,
        p.name,
        p.brand,
        p.pack,
        p.category,
        SUM(i.quantity) as units_sold,
        SUM(i.quantity * i.price) as gmv,
        COUNT(DISTINCT s.id) as orders_count,
        ROUND(AVG(i.price)) as avg_price
      FROM order_items i
      JOIN suborders s ON s.id = i.suborder_id
      JOIN orders o ON o.id = s.order_id
      JOIN products p ON p.id = i.product_id
      WHERE s.supplier_id = ? AND s.status = 'delivered' AND o.created >= ?
      GROUP BY p.id, p.name, p.brand, p.pack, p.category
      ORDER BY units_sold DESC
      LIMIT 20
    `, supplierId, startDate);

    // Fast-Growing Products (Comparing last 7 days vs previous 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const fourteenDaysAgo = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);

    const growthRows = all(`
      SELECT
        p.id as product_id,
        p.name,
        p.brand,
        p.pack,
        COALESCE(SUM(CASE WHEN o.created >= ? THEN i.quantity ELSE 0 END), 0) as units_recent,
        COALESCE(SUM(CASE WHEN o.created >= ? AND o.created < ? THEN i.quantity ELSE 0 END), 0) as units_previous
      FROM order_items i
      JOIN suborders s ON s.id = i.suborder_id
      JOIN orders o ON o.id = s.order_id
      JOIN products p ON p.id = i.product_id
      WHERE s.supplier_id = ? AND s.status = 'delivered' AND o.created >= ?
      GROUP BY p.id, p.name, p.brand, p.pack
      HAVING units_recent > 0 OR units_previous > 0
    `, sevenDaysAgo, fourteenDaysAgo, sevenDaysAgo, supplierId, fourteenDaysAgo);

    const fastGrowing = growthRows.map(r => {
      let growthRate = 0;
      let confidence = 'high';
      if (r.units_previous === 0) {
        growthRate = r.units_recent > 0 ? 100 : 0;
        confidence = 'low'; // Low sample size
      } else {
        growthRate = Math.round(((r.units_recent - r.units_previous) / r.units_previous) * 100);
      }
      return {
        ...r,
        growth_rate: growthRate,
        confidence
      };
    }).sort((a, b) => b.growth_rate - a.growth_rate).slice(0, 10);

    // Regional Demand Distribution in Damascus
    const regions = all(`
      SELECT
        o.zone,
        COUNT(DISTINCT s.id) as orders_count,
        COALESCE(SUM(i.quantity), 0) as units_sold,
        SUM(s.total) as gmv
      FROM suborders s
      JOIN orders o ON o.id = s.order_id
      LEFT JOIN order_items i ON i.suborder_id = s.id
      WHERE s.supplier_id = ? AND s.status = 'delivered' AND o.created >= ?
      GROUP BY o.zone
      ORDER BY gmv DESC
    `, supplierId, startDate);

    // Near Out-of-Stock Items for this Supplier
    const lowStock = all(`
      SELECT l.*, p.name, p.brand, p.pack
      FROM listings l
      JOIN products p ON p.id = l.product_id
      WHERE l.supplier_id = ? AND l.stock <= 10
      ORDER BY l.stock ASC
      LIMIT 10
    `, supplierId);

    // Market Benchmark with Strict Competitor Privacy Guard (Minimum Aggregation Threshold)
    const activeSuppliersCount = one('SELECT COUNT(DISTINCT supplier_id) as count FROM suborders WHERE status=\'delivered\'')?.count || 0;
    let marketBenchmark = {
      benchmark_available: false,
      reason: 'insufficient_competitor_sample',
      message: 'بيانات السوق المجمعة تتطلب 5 موردين مستقلين على الأقل لحماية لسرية بيانات الموردين والمنافسين'
    };

    if (activeSuppliersCount >= MIN_AGGREGATION_THRESHOLD) {
      const marketGrowth = all(`
        SELECT
          p.category,
          SUM(CASE WHEN o.created >= ? THEN i.quantity ELSE 0 END) as cur_market,
          SUM(CASE WHEN o.created >= ? AND o.created < ? THEN i.quantity ELSE 0 END) as prev_market
        FROM order_items i
        JOIN suborders s ON s.id = i.suborder_id
        JOIN orders o ON o.id = s.order_id
        JOIN products p ON p.id = i.product_id
        WHERE s.status = 'delivered' AND o.created >= ?
        GROUP BY p.category
      `, sevenDaysAgo, fourteenDaysAgo, sevenDaysAgo, fourteenDaysAgo);

      marketBenchmark = {
        benchmark_available: true,
        categories: marketGrowth.map(c => ({
          category: c.category,
          growth_percent: c.prev_market > 0 ? Math.round(((c.cur_market - c.prev_market) / c.prev_market) * 100) : 0
        }))
      };
    }

    return {
      period_days: days,
      performance: {
        revenue: revenueCurrent,
        gmv_growth_percent: gmvGrowth,
        delivered_orders: deliveredCurrent.length,
        total_orders: currentOrders.length,
        avg_order_value: deliveredCurrent.length > 0 ? Math.round(revenueCurrent / deliveredCurrent.length) : 0,
        cancellation_rate: cancellationRate,
        completion_rate: completionRate
      },
      top_products: topProducts,
      fast_growing: fastGrowing,
      regions,
      low_stock: lowStock,
      market_benchmark: marketBenchmark,
      last_updated: now()
    };
  }

  // 7. Merchant Pro Analytics (Purchase Intelligence)
  function getMerchantProOverview(merchantId, filters = {}) {
    const days = int(filters.days || 30, 'الأيام', 1, 365);
    const startDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const prevStartDate = new Date(Date.now() - days * 2 * 86400000).toISOString().slice(0, 10);

    const currentOrders = all(
      `SELECT s.* FROM suborders s JOIN orders o ON o.id=s.order_id WHERE o.merchant_id=? AND o.created >= ?`,
      merchantId,
      startDate
    );

    const prevOrders = all(
      `SELECT s.* FROM suborders s JOIN orders o ON o.id=s.order_id WHERE o.merchant_id=? AND o.created >= ? AND o.created < ?`,
      merchantId,
      prevStartDate,
      startDate
    );

    const deliveredCurrent = currentOrders.filter(s => s.status === 'delivered');
    const deliveredPrev = prevOrders.filter(s => s.status === 'delivered');

    const totalSpent = deliveredCurrent.reduce((a, s) => a + s.total, 0);
    const prevSpent = deliveredPrev.reduce((a, s) => a + s.total, 0);
    const spendGrowth = prevSpent > 0 ? Math.round(((totalSpent - prevSpent) / prevSpent) * 100) : 0;
    const totalDeliveryFees = deliveredCurrent.reduce((a, s) => a + s.fee, 0);

    // Top Purchased Items
    const topPurchased = all(`
      SELECT
        p.id as product_id,
        p.name,
        p.brand,
        p.pack,
        p.category,
        SUM(i.quantity) as units_bought,
        SUM(i.quantity * i.price) as total_spent,
        ROUND(AVG(i.price)) as avg_unit_price
      FROM order_items i
      JOIN suborders s ON s.id = i.suborder_id
      JOIN orders o ON o.id = s.order_id
      JOIN products p ON p.id = i.product_id
      WHERE o.merchant_id = ? AND s.status = 'delivered' AND o.created >= ?
      GROUP BY p.id, p.name, p.brand, p.pack, p.category
      ORDER BY total_spent DESC
      LIMIT 10
    `, merchantId, startDate);

    // Top Suppliers Ordered From
    const topSuppliers = all(`
      SELECT
        sp.id as supplier_id,
        sp.name,
        COUNT(s.id) as orders_count,
        SUM(s.total) as total_paid
      FROM suborders s
      JOIN orders o ON o.id = s.order_id
      JOIN suppliers sp ON sp.id = s.supplier_id
      WHERE o.merchant_id = ? AND s.status = 'delivered' AND o.created >= ?
      GROUP BY sp.id, sp.name
      ORDER BY total_paid DESC
    `, merchantId, startDate);

    // Wholesale Market Trends in RAFID (Named accurately: "الأكثر طلباً بالجملة عبر رافد")
    const wholesaleTrends = all(`
      SELECT
        p.id as product_id,
        p.name,
        p.brand,
        p.pack,
        p.category,
        SUM(i.quantity) as total_units_ordered,
        COUNT(DISTINCT s.order_id) as total_orders
      FROM order_items i
      JOIN suborders s ON s.id = i.suborder_id
      JOIN orders o ON o.id = s.order_id
      JOIN products p ON p.id = i.product_id
      WHERE s.status = 'delivered' AND o.created >= ?
      GROUP BY p.id, p.name, p.brand, p.pack, p.category
      ORDER BY total_units_ordered DESC
      LIMIT 10
    `, startDate);

    // Smart Alerts & Price Opportunities
    const alerts = [];

    // Check for cheaper alternatives across suppliers for the items this merchant buys
    for (const item of topPurchased) {
      const cheaperOption = one(`
        SELECT l.*, s.name as supplier_name
        FROM listings l
        JOIN suppliers s ON s.id = l.supplier_id
        WHERE l.product_id = ? AND s.active = 1 AND l.stock > 0 AND l.price < ?
        ORDER BY l.price ASC
        LIMIT 1
      `, item.product_id, item.avg_unit_price);

      if (cheaperOption) {
        alerts.push({
          type: 'saving_opportunity',
          title: `فرصة توفير على ${item.name}`,
          message: `يتوفر نفس الصنف (${item.pack}) لدى ${cheaperOption.supplier_name} بسعر ${cheaperOption.price.toLocaleString('ar-SY')} ل.س (أقل من متوسط شرائك ${item.avg_unit_price.toLocaleString('ar-SY')} ل.س)`
        });
      }
    }

    // Check upcoming invoice due dates
    const upcomingInvoices = all(`
      SELECT i.*, s.name as supplier_name
      FROM invoices i
      JOIN suppliers s ON s.id = i.supplier_id
      WHERE i.merchant_id = ? AND i.status IN ('issued','partially_paid') AND i.due_date <= date('now', '+3 days')
      ORDER BY i.due_date ASC
      LIMIT 5
    `, merchantId);

    for (const inv of upcomingInvoices) {
      alerts.push({
        type: 'due_invoice',
        title: `استحقاق فاتورة قادمة #${inv.invoice_number}`,
        message: `مبلغ ${(inv.total_amount - inv.paid_amount).toLocaleString('ar-SY')} ل.س مستحق لمورد ${inv.supplier_name} بتاريخ ${inv.due_date}`
      });
    }

    return {
      period_days: days,
      summary: {
        total_spend: totalSpent,
        total_spent: totalSpent,
        spend_growth_percent: spendGrowth,
        orders_count: deliveredCurrent.length,
        delivery_fees_paid: totalDeliveryFees
      },
      top_spent_products: topPurchased,
      top_purchased: topPurchased,
      top_suppliers: topSuppliers,
      wholesale_market_trends: wholesaleTrends,
      smart_alerts: alerts,
      alerts,
      last_updated: now()
    };
  }

  // 8. Safe CSV Export (Mitigating CSV Formula Injection)
  function exportReportCsv(type, rows) {
    if (!Array.isArray(rows) || rows.length === 0) return '\uFEFF';

    const sanitizeCell = val => {
      let strVal = String(val ?? '');
      // If starts with formula characters (=, +, -, @), prepend single quote
      if (/^[=+\-@]/.test(strVal)) {
        strVal = "'" + strVal;
      }
      // Escape double quotes
      if (strVal.includes(',') || strVal.includes('"') || strVal.includes('\n')) {
        return `"${strVal.replace(/"/g, '""')}"`;
      }
      return strVal;
    };

    const headers = Object.keys(rows[0]);
    const lines = [
      headers.map(sanitizeCell).join(','),
      ...rows.map(r => headers.map(h => sanitizeCell(r[h])).join(','))
    ];

    // Prepend UTF-8 BOM so Excel and text editors render Arabic correctly
    return '\uFEFF' + lines.join('\r\n');
  }

  return {
    getSubscription,
    hasProAccess,
    requirePro,
    activateSubscription,
    cancelSubscription,
    refreshAggregates,
    getSupplierProOverview,
    getMerchantProOverview,
    exportReportCsv
  };
}
