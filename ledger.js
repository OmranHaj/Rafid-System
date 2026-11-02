// RAFID Ledger: Double-entry financial bookkeeping, invoicing, collections & settlements.
import { randomBytes } from 'node:crypto';

let entrySeq = 0;

export function createLedgerEngine({ db, need, int, str, fail, transaction, audit, event, now, token }) {
  const one = (s, ...a) => db.prepare(s).get(...a);
  const all = (s, ...a) => db.prepare(s).all(...a);
  const run = (s, ...a) => db.prepare(s).run(...a);

  // 1. Schema migrations for Ledger
  db.exec(`
    CREATE TABLE IF NOT EXISTS ledger_accounts(
      id INTEGER PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('asset','liability','equity','revenue','expense')),
      currency TEXT NOT NULL DEFAULT 'SYP'
    );

    CREATE TABLE IF NOT EXISTS ledger_entries(
      id INTEGER PRIMARY KEY,
      entry_number TEXT NOT NULL UNIQUE,
      reference_type TEXT NOT NULL,
      reference_id TEXT NOT NULL,
      memo TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'SYP',
      created TEXT NOT NULL,
      posted INTEGER NOT NULL DEFAULT 1 CHECK(posted=1)
    );

    CREATE TABLE IF NOT EXISTS ledger_lines(
      id INTEGER PRIMARY KEY,
      entry_id INTEGER NOT NULL REFERENCES ledger_entries(id) ON DELETE RESTRICT,
      account_id INTEGER NOT NULL REFERENCES ledger_accounts(id),
      party_role TEXT CHECK(party_role IN ('merchant','supplier','driver','platform',NULL)),
      party_id INTEGER,
      debit INTEGER NOT NULL DEFAULT 0 CHECK(debit >= 0),
      credit INTEGER NOT NULL DEFAULT 0 CHECK(credit >= 0),
      currency TEXT NOT NULL DEFAULT 'SYP',
      CHECK((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
    );

    CREATE TABLE IF NOT EXISTS credit_terms(
      id INTEGER PRIMARY KEY,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      merchant_id INTEGER NOT NULL REFERENCES users(id),
      credit_limit INTEGER NOT NULL DEFAULT 0 CHECK(credit_limit >= 0),
      payment_term_days INTEGER NOT NULL DEFAULT 0 CHECK(payment_term_days >= 0),
      notes TEXT NOT NULL DEFAULT '',
      updated TEXT NOT NULL,
      UNIQUE(supplier_id, merchant_id)
    );

    CREATE TABLE IF NOT EXISTS invoices(
      id INTEGER PRIMARY KEY,
      invoice_number TEXT NOT NULL UNIQUE,
      suborder_id INTEGER NOT NULL UNIQUE REFERENCES suborders(id),
      order_id INTEGER NOT NULL REFERENCES orders(id),
      merchant_id INTEGER NOT NULL REFERENCES users(id),
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      total_amount INTEGER NOT NULL CHECK(total_amount > 0),
      goods_amount INTEGER NOT NULL CHECK(goods_amount >= 0),
      delivery_fee INTEGER NOT NULL CHECK(delivery_fee >= 0),
      paid_amount INTEGER NOT NULL DEFAULT 0 CHECK(paid_amount >= 0),
      currency TEXT NOT NULL DEFAULT 'SYP',
      status TEXT NOT NULL CHECK(status IN ('issued','partially_paid','paid','cancelled','disputed')),
      payment_terms TEXT NOT NULL DEFAULT 'cod',
      issue_date TEXT NOT NULL,
      due_date TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      created TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payments(
      id INTEGER PRIMARY KEY,
      receipt_number TEXT NOT NULL UNIQUE,
      payer_id INTEGER NOT NULL REFERENCES users(id),
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      amount INTEGER NOT NULL CHECK(amount > 0),
      unallocated_amount INTEGER NOT NULL DEFAULT 0 CHECK(unallocated_amount >= 0),
      currency TEXT NOT NULL DEFAULT 'SYP',
      payment_method TEXT NOT NULL DEFAULT 'cash' CHECK(payment_method IN ('cash','bank_transfer','settlement_credit','manual_adjustment')),
      collected_by_role TEXT NOT NULL CHECK(collected_by_role IN ('driver','supplier','admin')),
      collected_by_id INTEGER NOT NULL REFERENCES users(id),
      suborder_id INTEGER REFERENCES suborders(id),
      memo TEXT NOT NULL DEFAULT '',
      idempotency_key TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'recorded' CHECK(status IN ('recorded','allocated','partially_allocated','cancelled')),
      created TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payment_allocations(
      id INTEGER PRIMARY KEY,
      payment_id INTEGER NOT NULL REFERENCES payments(id),
      invoice_id INTEGER NOT NULL REFERENCES invoices(id),
      amount INTEGER NOT NULL CHECK(amount > 0),
      created TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS collections(
      id INTEGER PRIMARY KEY,
      suborder_id INTEGER NOT NULL UNIQUE REFERENCES suborders(id),
      invoice_id INTEGER REFERENCES invoices(id),
      driver_id INTEGER NOT NULL REFERENCES users(id),
      driver_type TEXT NOT NULL CHECK(driver_type IN ('supplier','platform')),
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      merchant_id INTEGER NOT NULL REFERENCES users(id),
      expected_amount INTEGER NOT NULL CHECK(expected_amount >= 0),
      collected_amount INTEGER NOT NULL CHECK(collected_amount >= 0),
      remitted_amount INTEGER NOT NULL DEFAULT 0 CHECK(remitted_amount >= 0),
      disputed_amount INTEGER NOT NULL DEFAULT 0 CHECK(disputed_amount >= 0),
      remittance_status TEXT NOT NULL CHECK(remittance_status IN ('pending_collection','collected','pending_remittance','partially_remitted','reconciled','disputed')),
      currency TEXT NOT NULL DEFAULT 'SYP',
      created TEXT NOT NULL,
      updated TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cash_remittances(
      id INTEGER PRIMARY KEY,
      remittance_number TEXT NOT NULL UNIQUE,
      driver_id INTEGER NOT NULL REFERENCES users(id),
      driver_type TEXT NOT NULL CHECK(driver_type IN ('supplier','platform')),
      receiver_role TEXT NOT NULL CHECK(receiver_role IN ('supplier','admin')),
      receiver_id INTEGER NOT NULL REFERENCES users(id),
      supplier_id INTEGER REFERENCES suppliers(id),
      amount INTEGER NOT NULL CHECK(amount > 0),
      currency TEXT NOT NULL DEFAULT 'SYP',
      status TEXT NOT NULL CHECK(status IN ('submitted','verified','disputed')),
      note TEXT NOT NULL DEFAULT '',
      created TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reconciliations(
      id INTEGER PRIMARY KEY,
      collection_id INTEGER NOT NULL REFERENCES collections(id),
      remittance_id INTEGER REFERENCES cash_remittances(id),
      approved_by INTEGER NOT NULL REFERENCES users(id),
      expected_amount INTEGER NOT NULL,
      actual_amount INTEGER NOT NULL,
      variance INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('reconciled','disputed','settled')),
      resolution_note TEXT NOT NULL DEFAULT '',
      resolved_at TEXT,
      created TEXT NOT NULL
    );
  `);

  // 2. Seed standard Chart of Accounts
  const defaultAccounts = [
    ['AR_MERCHANT', 'ذمم مدينة - محلات', 'asset'],
    ['CASH_DRIVER_SUPPLIER', 'عهدة نقدية - سائق المورد', 'asset'],
    ['CASH_DRIVER_PLATFORM', 'عهدة نقدية - سائق رافد', 'asset'],
    ['CASH_SUPPLIER', 'صندوق المورد', 'asset'],
    ['CASH_PLATFORM', 'صندوق رافد', 'asset'],
    ['REVENUE_GOODS', 'إيرادات مبيعات بضائع', 'revenue'],
    ['REVENUE_DELIVERY', 'إيرادات خدمات التوصيل', 'revenue'],
    ['COMMISSION_PLATFORM', 'عمولة المنصة', 'revenue'],
    ['DISPUTED_SETTLEMENT', 'فروقات وتسويات معلقة', 'asset'],
    ['MERCHANT_PREPAYMENT', 'أرصدة دائنة ودفعات مقدمة للمحلات', 'liability']
  ];

  for (const [code, name, type] of defaultAccounts) {
    if (!one('SELECT id FROM ledger_accounts WHERE code=?', code)) {
      run('INSERT INTO ledger_accounts(code, name, type, currency) VALUES(?,?,?,?)', code, name, type, 'SYP');
    }
  }

  const accountIdMap = () => {
    const rows = all('SELECT id, code FROM ledger_accounts');
    const map = new Map();
    for (const r of rows) map.set(r.code, r.id);
    return map;
  };

  // 3. Core Double-Entry Bookkeeping function
  function postEntry({ referenceType, referenceId, memo, lines, currency = 'SYP' }) {
    need(Array.isArray(lines) && lines.length >= 2, 'القيد المحاسبي يتطلب طرفين على الأقل');
    const accounts = accountIdMap();

    let totalDebit = 0;
    let totalCredit = 0;

    for (const line of lines) {
      need(line.accountCode && accounts.has(line.accountCode), `حساب غير معرف: ${line.accountCode}`);
      const debit = Number(line.debit || 0);
      const credit = Number(line.credit || 0);
      need(Number.isSafeInteger(debit) && debit >= 0, 'المدين غير صالح');
      need(Number.isSafeInteger(credit) && credit >= 0, 'الدائن غير صالح');
      need((debit > 0 && credit === 0) || (credit > 0 && debit === 0), 'يجب أن يكون الطرف مديناً أو دائناً حصراً');
      totalDebit += debit;
      totalCredit += credit;
    }

    need(totalDebit === totalCredit, `القيد غير متوازن: المدين (${totalDebit}) لا يساوي الدائن (${totalCredit})`);
    need(totalDebit > 0, 'لا يمكن ترحيل قيد بقيمة صفر');

    const entryNumber = 'JE-' + Date.now().toString(36).toUpperCase() + '-' + (++entrySeq) + '-' + randomBytes(4).toString('hex').toUpperCase();
    const entryRes = run(
      'INSERT INTO ledger_entries(entry_number, reference_type, reference_id, memo, currency, created, posted) VALUES(?,?,?,?,?,?,1)',
      entryNumber,
      referenceType,
      String(referenceId),
      str(memo, 'بيان القيد', 300),
      currency,
      now()
    );
    const entryId = Number(entryRes.lastInsertRowid);

    for (const line of lines) {
      run(
        'INSERT INTO ledger_lines(entry_id, account_id, party_role, party_id, debit, credit, currency) VALUES(?,?,?,?,?,?,?)',
        entryId,
        accounts.get(line.accountCode),
        line.partyRole || null,
        line.partyId || null,
        Number(line.debit || 0),
        Number(line.credit || 0),
        currency
      );
    }

    return entryId;
  }

  // Calculate due date based on payment terms
  function calculateDueDate(issueDateStr, termDays = 0) {
    const issueDate = new Date(issueDateStr);
    const dueDate = new Date(issueDate.getTime() + termDays * 86400000);
    return dueDate.toISOString().slice(0, 10);
  }

  // 4. Hook when a suborder is delivered (Invoked at delivery time)
  function onSuborderDelivered(sub, driverUser, collectedAmount) {
    return transaction(() => {
      // Check if invoice already exists to prevent duplicate processing
      let inv = one('SELECT * FROM invoices WHERE suborder_id=?', sub.id);
      if (inv) return inv;

      const order = one('SELECT * FROM orders WHERE id=?', sub.order_id);
      need(order, 'الطلب الرئيسي غير موجود');

      // Fetch merchant credit terms with this supplier
      const creditTerm = one('SELECT * FROM credit_terms WHERE supplier_id=? AND merchant_id=?', sub.supplier_id, order.merchant_id);
      const termDays = creditTerm ? creditTerm.payment_term_days : 0;
      const paymentTerms = termDays > 0 ? `net_${termDays}` : 'cod';
      const issueDate = now();
      const dueDate = calculateDueDate(issueDate, termDays);

      const goodsAmount = sub.total - sub.fee;
      const invoiceNumber = `INV-${sub.supplier_id}-${sub.id}-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`;

      // Insert invoice
      const invRes = run(
        `INSERT INTO invoices(invoice_number, suborder_id, order_id, merchant_id, supplier_id, total_amount, goods_amount, delivery_fee, paid_amount, currency, status, payment_terms, issue_date, due_date, notes, created)
         VALUES(?,?,?,?,?,?,?,?,0,'SYP','issued',?,?,?,?,?)`,
        invoiceNumber,
        sub.id,
        order.id,
        order.merchant_id,
        sub.supplier_id,
        sub.total,
        goodsAmount,
        sub.fee,
        paymentTerms,
        issueDate.slice(0, 10),
        dueDate,
        `فاتورة طلب فرعي #${sub.id}`,
        now()
      );
      const invoiceId = Number(invRes.lastInsertRowid);

      // Post Receivable Entry:
      // Debit: AR_MERCHANT (sub.total)
      // Credit: REVENUE_GOODS (goodsAmount)
      // Credit: REVENUE_DELIVERY (sub.fee)
      const lines = [
        { accountCode: 'AR_MERCHANT', partyRole: 'merchant', partyId: order.merchant_id, debit: sub.total, credit: 0 },
        { accountCode: 'REVENUE_GOODS', partyRole: 'supplier', partyId: sub.supplier_id, debit: 0, credit: goodsAmount }
      ];
      if (sub.fee > 0) {
        lines.push({ accountCode: 'REVENUE_DELIVERY', partyRole: 'supplier', partyId: sub.supplier_id, debit: 0, credit: sub.fee });
      }

      postEntry({
        referenceType: 'invoice',
        referenceId: invoiceId,
        memo: `استحقاق فاتورة #${invoiceNumber} للطلب #${sub.id}`,
        lines
      });

      // Handle Cash on Delivery / Collection
      const driverType = sub.method === 'platform' ? 'platform' : 'supplier';
      const actualCollected = Math.max(0, Math.min(collectedAmount, sub.total));

      let remittanceStatus = 'pending_collection';
      if (actualCollected === sub.total) {
        remittanceStatus = 'pending_remittance';
      } else if (actualCollected > 0) {
        remittanceStatus = 'pending_remittance';
      } else {
        remittanceStatus = termDays > 0 ? 'reconciled' : 'disputed';
      }

      const colRes = run(
        `INSERT INTO collections(suborder_id, invoice_id, driver_id, driver_type, supplier_id, merchant_id, expected_amount, collected_amount, remitted_amount, disputed_amount, remittance_status, currency, created, updated)
         VALUES(?,?,?,?,?,?,?,?,0,0,?,'SYP',?,?)`,
        sub.id,
        invoiceId,
        driverUser.id,
        driverType,
        sub.supplier_id,
        order.merchant_id,
        sub.total,
        actualCollected,
        remittanceStatus,
        now(),
        now()
      );
      const collectionId = Number(colRes.lastInsertRowid);

      // If driver collected cash, record Payment and custody
      if (actualCollected > 0) {
        const receiptNumber = `REC-${sub.id}-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`;
        const payRes = run(
          `INSERT INTO payments(receipt_number, payer_id, supplier_id, amount, unallocated_amount, currency, payment_method, collected_by_role, collected_by_id, suborder_id, memo, idempotency_key, status, created)
           VALUES(?,?,?,?,0,'SYP','cash','driver',?,?,?,?,'allocated',?)`,
          receiptNumber,
          order.merchant_id,
          sub.supplier_id,
          actualCollected,
          driverUser.id,
          sub.id,
          `تحصيل نقدي عند التسليم للطلب #${sub.id}`,
          `receipt-delivery-${sub.id}`,
          now()
        );
        const paymentId = Number(payRes.lastInsertRowid);

        run(
          'INSERT INTO payment_allocations(payment_id, invoice_id, amount, created) VALUES(?,?,?,?)',
          paymentId,
          invoiceId,
          actualCollected,
          now()
        );

        // Update invoice paid amount & status
        const newPaid = actualCollected;
        const newStatus = newPaid >= sub.total ? 'paid' : 'partially_paid';
        run('UPDATE invoices SET paid_amount=?, status=? WHERE id=?', newPaid, newStatus, invoiceId);

        // Record Driver Custody in Ledger:
        // Debit: CASH_DRIVER_SUPPLIER or CASH_DRIVER_PLATFORM
        // Credit: AR_MERCHANT
        const driverAccount = driverType === 'platform' ? 'CASH_DRIVER_PLATFORM' : 'CASH_DRIVER_SUPPLIER';
        postEntry({
          referenceType: 'payment',
          referenceId: paymentId,
          memo: `تحصيل نقد عهدة سائق عند التسليم - إيصال #${receiptNumber}`,
          lines: [
            { accountCode: driverAccount, partyRole: 'driver', partyId: driverUser.id, debit: actualCollected, credit: 0 },
            { accountCode: 'AR_MERCHANT', partyRole: 'merchant', partyId: order.merchant_id, debit: 0, credit: actualCollected }
          ]
        });
      }

      return one('SELECT * FROM invoices WHERE id=?', invoiceId);
    });
  }

  // 5. Manual Payment / Partial Payment Allocation
  function recordPayment(u, b) {
    return transaction(() => {
      const payerId = int(b.merchant_id, 'المحل', 1);
      const supplierId = u.role === 'supplier' ? u.supplier_id : int(b.supplier_id, 'المورد', 1);
      const amount = int(b.amount, 'المبلغ المدفوع', 1);
      const method = b.payment_method || 'cash';
      need(['cash', 'bank_transfer', 'settlement_credit', 'manual_adjustment'].includes(method), 'طريقة الدفع غير صالحة');
      const memo = str(b.memo || 'دفعة نقدية مسجلة', 'البيان', 300);
      const idempotencyKey = b.idempotency_key ? str(b.idempotency_key, 'مفتاح التحقق', 100) : null;

      if (idempotencyKey) {
        const existing = one('SELECT * FROM payments WHERE idempotency_key=?', idempotencyKey);
        if (existing) return existing;
      }

      // Check merchant existence
      const merchant = one("SELECT id, name FROM users WHERE id=? AND role='merchant'", payerId);
      need(merchant, 'المحل غير موجود');

      // Check supplier existence
      const supplier = one('SELECT id, name FROM suppliers WHERE id=?', supplierId);
      need(supplier, 'المورد غير موجود');

      // Invoices to allocate to
      let unpaidInvoices = [];
      if (Array.isArray(b.invoice_ids) && b.invoice_ids.length > 0) {
        const requestedIds = b.invoice_ids.map(id => int(id, 'الفاتورة', 1));
        unpaidInvoices = all(
          `SELECT * FROM invoices WHERE id IN (${requestedIds.join(',')}) AND merchant_id=? AND supplier_id=? AND status IN ('issued','partially_paid') ORDER BY due_date ASC, id ASC`,
          payerId,
          supplierId
        );
      } else {
        // Auto-allocate to oldest unpaid invoices (FIFO)
        unpaidInvoices = all(
          `SELECT * FROM invoices WHERE merchant_id=? AND supplier_id=? AND status IN ('issued','partially_paid') ORDER BY due_date ASC, id ASC`,
          payerId,
          supplierId
        );
      }

      const receiptNumber = 'REC-' + Date.now().toString(36).toUpperCase() + '-' + token().slice(0, 4).toUpperCase();
      let remaining = amount;

      const payRes = run(
        `INSERT INTO payments(receipt_number, payer_id, supplier_id, amount, unallocated_amount, currency, payment_method, collected_by_role, collected_by_id, memo, idempotency_key, status, created)
         VALUES(?,?,?,?,?,'SYP',?,?,?,?,?,'recorded',?)`,
        receiptNumber,
        payerId,
        supplierId,
        amount,
        amount,
        method,
        u.role,
        u.id,
        memo,
        idempotencyKey,
        now()
      );
      const paymentId = Number(payRes.lastInsertRowid);

      // Allocate to invoices
      for (const inv of unpaidInvoices) {
        if (remaining <= 0) break;
        const due = inv.total_amount - inv.paid_amount;
        const alloc = Math.min(remaining, due);
        if (alloc <= 0) continue;

        run('INSERT INTO payment_allocations(payment_id, invoice_id, amount, created) VALUES(?,?,?,?)', paymentId, inv.id, alloc, now());
        const newPaid = inv.paid_amount + alloc;
        const newStatus = newPaid >= inv.total_amount ? 'paid' : 'partially_paid';
        run('UPDATE invoices SET paid_amount=?, status=? WHERE id=?', newPaid, newStatus, inv.id);
        remaining -= alloc;
      }

      const allocatedAmount = amount - remaining;
      const finalStatus = remaining === 0 ? 'allocated' : remaining < amount ? 'partially_allocated' : 'recorded';
      run('UPDATE payments SET unallocated_amount=?, status=? WHERE id=?', remaining, finalStatus, paymentId);

      // Post in Ledger:
      // Debit: CASH_SUPPLIER
      // Credit: AR_MERCHANT (allocated)
      // Credit: MERCHANT_PREPAYMENT (remaining if overpaid)
      const lines = [
        { accountCode: 'CASH_SUPPLIER', partyRole: 'supplier', partyId: supplierId, debit: amount, credit: 0 }
      ];

      if (allocatedAmount > 0) {
        lines.push({ accountCode: 'AR_MERCHANT', partyRole: 'merchant', partyId: payerId, debit: 0, credit: allocatedAmount });
      }
      if (remaining > 0) {
        lines.push({ accountCode: 'MERCHANT_PREPAYMENT', partyRole: 'merchant', partyId: payerId, debit: 0, credit: remaining });
      }

      postEntry({
        referenceType: 'payment',
        referenceId: paymentId,
        memo: `سداد دفعة إيصال #${receiptNumber} من ${merchant.name}`,
        lines
      });

      audit(u, 'payment.create', paymentId);
      return one('SELECT * FROM payments WHERE id=?', paymentId);
    });
  }

  // 6. Cash Remittance (Driver -> Supplier or Driver -> Platform Admin)
  function recordRemittance(u, b) {
    return transaction(() => {
      const driverId = u.role === 'driver' ? u.id : int(b.driver_id, 'السائق', 1);
      const driver = one('SELECT d.*, u.name, u.role FROM drivers d JOIN users u ON u.id=d.user_id WHERE d.user_id=?', driverId);
      need(driver, 'السائق غير موجود');

      const amount = int(b.amount, 'المبلغ المورد', 1);
      const receiverRole = driver.supplier_id ? 'supplier' : 'admin';
      const receiverId = driver.supplier_id
        ? one('SELECT id FROM users WHERE role=\'supplier\' AND supplier_id=?', driver.supplier_id)?.id
        : one('SELECT id FROM users WHERE role=\'admin\' ORDER BY id LIMIT 1')?.id;
      need(receiverId, 'المستلم المخول غير موجود');

      const remittanceNumber = 'REM-' + Date.now().toString(36).toUpperCase() + '-' + token().slice(0, 4).toUpperCase();
      const remRes = run(
        `INSERT INTO cash_remittances(remittance_number, driver_id, driver_type, receiver_role, receiver_id, supplier_id, amount, currency, status, note, created)
         VALUES(?,?,?,?,?,?,?,'SYP','submitted',?,?)`,
        remittanceNumber,
        driverId,
        driver.supplier_id ? 'supplier' : 'platform',
        receiverRole,
        receiverId,
        driver.supplier_id,
        amount,
        str(b.note || 'توريد نقد عهدة', 'الملاحظة', 300),
        now()
      );
      const remittanceId = Number(remRes.lastInsertRowid);

      audit(u, 'remittance.create', remittanceId);
      return one('SELECT * FROM cash_remittances WHERE id=?', remittanceId);
    });
  }

  // 7. Verify & Reconcile Remittance
  function reconcileRemittance(u, b) {
    return transaction(() => {
      const remittanceId = int(b.remittance_id, 'إشعار التوريد', 1);
      const rem = one('SELECT * FROM cash_remittances WHERE id=?', remittanceId);
      need(rem, 'إشعار التوريد غير موجود', 404);
      if (u.role === 'supplier') {
        need(rem.supplier_id === u.supplier_id, 'لا تملك صلاحية مطابقة هذا التوريد', 403);
      } else {
        need(u.role === 'admin', 'صلاحية الإدارة مطلوبة', 403);
      }
      need(rem.status === 'submitted', 'تمت مطابقة هذا الإشعار مسبقاً');

      const verifiedAmount = int(b.verified_amount ?? rem.amount, 'المبلغ الفعلي المستلم', 0);
      const note = str(b.note || 'اعتماد المطابقة والتسوية', 'ملاحظة المطابقة', 300);

      const variance = rem.amount - verifiedAmount;
      const finalStatus = variance === 0 ? 'verified' : 'disputed';

      run('UPDATE cash_remittances SET status=? WHERE id=?', finalStatus, rem.id);

      // Ledger Double-Entry for Remittance Transfer:
      // Transfer custody from Driver to Supplier or Platform Cash Box
      const driverAccount = rem.driver_type === 'platform' ? 'CASH_DRIVER_PLATFORM' : 'CASH_DRIVER_SUPPLIER';
      const receiverAccount = rem.driver_type === 'platform' ? 'CASH_PLATFORM' : 'CASH_SUPPLIER';

      const lines = [
        { accountCode: receiverAccount, partyRole: rem.receiver_role, partyId: rem.receiver_id, debit: verifiedAmount, credit: 0 },
        { accountCode: driverAccount, partyRole: 'driver', partyId: rem.driver_id, debit: 0, credit: rem.amount }
      ];

      // If driver handed over less than expected, remaining is booked to DISPUTED_SETTLEMENT
      if (variance > 0) {
        lines.push({ accountCode: 'DISPUTED_SETTLEMENT', partyRole: 'driver', partyId: rem.driver_id, debit: variance, credit: 0 });
      } else if (variance < 0) {
        // If driver handed over more, credit difference
        lines.push({ accountCode: 'DISPUTED_SETTLEMENT', partyRole: 'driver', partyId: rem.driver_id, debit: 0, credit: Math.abs(variance) });
      }

      postEntry({
        referenceType: 'remittance',
        referenceId: rem.id,
        memo: `تسوية وتوريد نقد من السائق - إشعار #${rem.remittance_number}`,
        lines
      });

      // Update collections for this driver to mark remitted
      let unremittedCols = all(
        "SELECT * FROM collections WHERE driver_id=? AND remittance_status IN ('collected','pending_remittance') ORDER BY id ASC",
        rem.driver_id
      );

      let remBalance = verifiedAmount;
      for (const col of unremittedCols) {
        if (remBalance <= 0) break;
        const pending = col.collected_amount - col.remitted_amount;
        const alloc = Math.min(remBalance, pending);
        if (alloc <= 0) continue;

        const newRemitted = col.remitted_amount + alloc;
        const newStatus = newRemitted >= col.collected_amount ? 'reconciled' : 'partially_remitted';
        run('UPDATE collections SET remitted_amount=?, remittance_status=?, updated=? WHERE id=?', newRemitted, newStatus, now(), col.id);
        remBalance -= alloc;
      }

      audit(u, 'remittance.verify', rem.id);
      return { ok: true, status: finalStatus, variance };
    });
  }

  // 8. Statements & Aging Reports
  function getMerchantStatement(merchantId, supplierId = null) {
    let where = 'WHERE i.merchant_id=?';
    const params = [merchantId];
    if (supplierId) {
      where += ' AND i.supplier_id=?';
      params.push(supplierId);
    }

    const invoices = all(
      `SELECT i.*, s.name as supplier_name FROM invoices i JOIN suppliers s ON s.id=i.supplier_id ${where} ORDER BY i.id DESC`,
      ...params
    );

    const paymentsList = all(
      `SELECT p.*, s.name as supplier_name FROM payments p JOIN suppliers s ON s.id=p.supplier_id WHERE p.payer_id=? ${supplierId ? 'AND p.supplier_id=?' : ''} ORDER BY p.id DESC`,
      ...(supplierId ? [merchantId, supplierId] : [merchantId])
    );

    const totalInvoiced = invoices.reduce((acc, i) => acc + i.total_amount, 0);
    const totalPaid = invoices.reduce((acc, i) => acc + i.paid_amount, 0);
    const outstanding = totalInvoiced - totalPaid;

    const todayStr = new Date().toISOString().slice(0, 10);
    const overdue = invoices
      .filter(i => i.status !== 'paid' && i.due_date < todayStr)
      .reduce((acc, i) => acc + (i.total_amount - i.paid_amount), 0);

    return {
      merchant_id: merchantId,
      supplier_id: supplierId,
      total_invoiced: totalInvoiced,
      total_paid: totalPaid,
      outstanding_balance: outstanding,
      overdue_balance: overdue,
      invoices,
      payments: paymentsList
    };
  }

  function getSupplierAgingReport(supplierId) {
    const invoices = all(
      `SELECT i.*, u.name as merchant_name FROM invoices i JOIN users u ON u.id=i.merchant_id WHERE i.supplier_id=? AND i.status IN ('issued','partially_paid') ORDER BY i.due_date ASC`,
      supplierId
    );

    const nowMs = Date.now();
    const buckets = { current: 0, days_1_7: 0, days_8_15: 0, days_16_30: 0, days_30_plus: 0 };
    const delinquentMerchants = new Map();

    for (const inv of invoices) {
      const balance = inv.total_amount - inv.paid_amount;
      const dueMs = Date.parse(inv.due_date);
      const daysOverdue = Math.floor((nowMs - dueMs) / 86400000);

      if (daysOverdue <= 0) {
        buckets.current += balance;
      } else if (daysOverdue <= 7) {
        buckets.days_1_7 += balance;
      } else if (daysOverdue <= 15) {
        buckets.days_8_15 += balance;
      } else if (daysOverdue <= 30) {
        buckets.days_16_30 += balance;
      } else {
        buckets.days_30_plus += balance;
      }

      if (daysOverdue > 0) {
        const cur = delinquentMerchants.get(inv.merchant_id) || {
          merchant_id: inv.merchant_id,
          name: inv.merchant_name,
          overdue: 0,
          invoices_count: 0
        };
        cur.overdue += balance;
        cur.invoices_count += 1;
        delinquentMerchants.set(inv.merchant_id, cur);
      }
    }

    return {
      buckets,
      total_receivables: Object.values(buckets).reduce((a, b) => a + b, 0),
      overdue_receivables: buckets.days_1_7 + buckets.days_8_15 + buckets.days_16_30 + buckets.days_30_plus,
      delinquent_merchants: [...delinquentMerchants.values()].sort((a, b) => b.overdue - a.overdue),
      invoices
    };
  }

  // 9. Credit terms & limits
  function setCreditTerms(u, b) {
    return transaction(() => {
      const supplierId = u.role === 'supplier' ? u.supplier_id : int(b.supplier_id, 'المورد', 1);
      const merchantId = int(b.merchant_id, 'المحل', 1);
      const creditLimit = int(b.credit_limit, 'سقف الذمم', 0);
      const termDays = int(b.payment_term_days, 'مهلة السداد بالأيام', 0, 365);
      const notes = str(b.notes || '', 'الملاحظات', 500);

      run(
        `INSERT INTO credit_terms(supplier_id, merchant_id, credit_limit, payment_term_days, notes, updated)
         VALUES(?,?,?,?,?,?)
         ON CONFLICT(supplier_id, merchant_id) DO UPDATE SET credit_limit=excluded.credit_limit, payment_term_days=excluded.payment_term_days, notes=excluded.notes, updated=excluded.updated`,
        supplierId,
        merchantId,
        creditLimit,
        termDays,
        notes,
        now()
      );

      audit(u, 'credit_terms.set', `${supplierId}:${merchantId}`);
      return one('SELECT * FROM credit_terms WHERE supplier_id=? AND merchant_id=?', supplierId, merchantId);
    });
  }

  function getCreditTerms(supplierId, merchantId) {
    return one('SELECT * FROM credit_terms WHERE supplier_id=? AND merchant_id=?', supplierId, merchantId) || {
      supplier_id: supplierId,
      merchant_id: merchantId,
      credit_limit: 0,
      payment_term_days: 0,
      notes: ''
    };
  }

  // Backfill utility for historical delivered suborders that might predate ledger tables
  function backfillHistoricalOrders() {
    const historical = all("SELECT s.* FROM suborders s WHERE s.status='delivered' AND s.id NOT IN (SELECT suborder_id FROM invoices)");
    for (const sub of historical) {
      transaction(() => {
        const order = one('SELECT * FROM orders WHERE id=?', sub.order_id);
        if (!order) return;
        const invoiceNumber = `INV-${sub.supplier_id}-${sub.id}-HIST`;
        const goodsAmount = sub.total - sub.fee;
        const issueDate = sub.delivery_date ? sub.delivery_date : now().slice(0, 10);
        const invRes = run(
          `INSERT INTO invoices(invoice_number, suborder_id, order_id, merchant_id, supplier_id, total_amount, goods_amount, delivery_fee, paid_amount, currency, status, payment_terms, issue_date, due_date, notes, created)
           VALUES(?,?,?,?,?,?,?,?,0,'SYP','issued','cod',?,?,?,?)`,
          invoiceNumber,
          sub.id,
          order.id,
          order.merchant_id,
          sub.supplier_id,
          sub.total,
          goodsAmount,
          sub.fee,
          issueDate,
          issueDate,
          'backfill_historical',
          now()
        );
        const invoiceId = Number(invRes.lastInsertRowid);

        const lines = [
          { accountCode: 'AR_MERCHANT', partyRole: 'merchant', partyId: order.merchant_id, debit: sub.total, credit: 0 },
          { accountCode: 'REVENUE_GOODS', partyRole: 'supplier', partyId: sub.supplier_id, debit: 0, credit: goodsAmount }
        ];
        if (sub.fee > 0) lines.push({ accountCode: 'REVENUE_DELIVERY', partyRole: 'supplier', partyId: sub.supplier_id, debit: 0, credit: sub.fee });

        postEntry({
          referenceType: 'invoice',
          referenceId: invoiceId,
          memo: `استحقاق فاتورة تاريخية للطلب #${sub.id}`,
          lines
        });

        // If collection was confirmed, record collection and payment
        const collected = sub.collection || 0;
        if (collected > 0) {
          const colRes = run(
            `INSERT INTO collections(suborder_id, invoice_id, driver_id, driver_type, supplier_id, merchant_id, expected_amount, collected_amount, remitted_amount, disputed_amount, remittance_status, currency, created, updated)
             VALUES(?,?,1,'supplier',?,?,?,?,?,0,'reconciled','SYP',?,?)`,
            sub.id,
            invoiceId,
            sub.supplier_id,
            order.merchant_id,
            sub.total,
            collected,
            collected,
            now(),
            now()
          );
          const payRes = run(
            `INSERT INTO payments(receipt_number, payer_id, supplier_id, amount, unallocated_amount, currency, payment_method, collected_by_role, collected_by_id, suborder_id, memo, idempotency_key, status, created)
             VALUES(?,?,?,?,0,'SYP','cash','supplier',?,?,?,?,'allocated',?)`,
            `REC-${sub.id}-HIST-${randomBytes(3).toString('hex').toUpperCase()}`,
            order.merchant_id,
            sub.supplier_id,
            collected,
            sub.supplier_id,
            sub.id,
            `تحصيل تاريخي للطلب #${sub.id}`,
            `hist-receipt-${sub.id}`,
            now()
          );
          const paymentId = Number(payRes.lastInsertRowid);
          run('INSERT INTO payment_allocations(payment_id, invoice_id, amount, created) VALUES(?,?,?,?)', paymentId, invoiceId, collected, now());
          run("UPDATE invoices SET paid_amount=?, status='paid' WHERE id=?", collected, invoiceId);

          postEntry({
            referenceType: 'payment',
            referenceId: paymentId,
            memo: `تحصيل تاريخي للطلب #${sub.id}`,
            lines: [
              { accountCode: 'CASH_SUPPLIER', partyRole: 'supplier', partyId: sub.supplier_id, debit: collected, credit: 0 },
              { accountCode: 'AR_MERCHANT', partyRole: 'merchant', partyId: order.merchant_id, debit: 0, credit: collected }
            ]
          });
        }
      });
    }
  }

  // Run initial backfill on startup
  backfillHistoricalOrders();

  return {
    postEntry,
    onSuborderDelivered,
    recordPayment,
    recordRemittance,
    reconcileRemittance,
    getMerchantStatement,
    getSupplierAgingReport,
    setCreditTerms,
    getCreditTerms
  };
}
