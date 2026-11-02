import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const WALLET = '0912345678';

test('RAFID commission: 0.5% platform share and simulated Sham Cash', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rafid-commission-'));
  const dbPath = join(dir, 'test.sqlite');
  const port = 43000 + Math.floor(Math.random() * 8000);
  const base = `http://127.0.0.1:${port}`;
  let server, output = '';

  async function start(env = { DEMO_MODE: '1' }, path = dbPath) {
    output = '';
    server = spawn(process.execPath, ['server.js'], {
      cwd: process.cwd(),
      env: { ...process.env, ...env, DB_PATH: path, PORT: String(port), HOST: '127.0.0.1' }
    });
    server.stdout.on('data', b => output += b);
    server.stderr.on('data', b => output += b);
    await new Promise((resolve, reject) => {
      const until = Date.now() + 12000;
      const timer = setInterval(() => {
        if (output.includes('RAFID listening')) { clearInterval(timer); resolve(); }
        else if (server.exitCode !== null || Date.now() > until) { clearInterval(timer); reject(new Error(output)); }
      }, 40);
    });
  }

  async function stop() {
    if (server.exitCode === null) {
      const done = new Promise(r => server.once('exit', r));
      server.kill();
      await done;
    }
  }

  async function request(path, { body, cookie, headers = {}, status = 200 } = {}) {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = await response.json();
    assert.equal(response.status, status, `${path}: ${JSON.stringify(data)}`);
    return { data, response };
  }

  async function login(account) {
    const { response } = await request('/api/login', { body: { email: account + '@rafid.local', password: 'RafidDemo2026!' } });
    return response.headers.get('set-cookie').split(';')[0];
  }

  let orderSeq = 0;
  async function placeOrder(merchant, listingId, payment = {}) {
    const quote = await request('/api/quotes', {
      cookie: merchant,
      body: { zone: 'دمشق', address: 'دمشق - الميدان', items: [{ listing_id: listingId, quantity: 2 }] }
    });
    const order = await request('/api/orders', {
      cookie: merchant,
      body: { quote_id: quote.data.id, ...payment },
      headers: { 'Idempotency-Key': `commission-${++orderSeq}` }
    });
    const orders = (await request('/api/orders', { cookie: merchant })).data;
    return orders.find(o => o.id === order.data.id).suborders[0];
  }

  async function deliver(merchant, supplier, driver, sub, body = {}) {
    for (const action of ['confirm', 'prepare', 'ready']) {
      await request(`/api/suborders/${sub.id}/action`, { cookie: supplier, body: { action } });
    }
    await request('/api/dispatch', { cookie: supplier, body: { driver_id: 5, suborder_ids: [sub.id] } });
    await request(`/api/suborders/${sub.id}/action`, { cookie: driver, body: { action: 'accept' } });
    await request(`/api/suborders/${sub.id}/action`, { cookie: driver, body: { action: 'pickup' } });
    const orders = (await request('/api/orders', { cookie: merchant })).data;
    const code = orders.flatMap(o => o.suborders).find(s => s.id === sub.id).deliveryCode;
    await request(`/api/suborders/${sub.id}/action`, { cookie: driver, body: { action: 'depart' } });
    await request(`/api/suborders/${sub.id}/action`, { cookie: driver, body: { action: 'arrive' } });
    await request(`/api/suborders/${sub.id}/deliver`, { cookie: driver, body: { code, ...body } });
  }

  await start();
  const rawDb = new DatabaseSync(dbPath);
  const assertBooksBalance = () => {
    const { debit, credit } = rawDb.prepare('SELECT sum(debit) debit,sum(credit) credit FROM ledger_lines').get();
    assert.equal(debit, credit);
    const unbalanced = rawDb.prepare('SELECT entry_id FROM ledger_lines GROUP BY entry_id HAVING sum(debit)<>sum(credit)').all();
    assert.equal(unbalanced.length, 0);
  };

  try {
    const merchant = await login('merchant');
    const supplier = await login('supplier');
    const supplier2 = await login('supplier2');
    const admin = await login('admin');
    const driver = await login('driver');

    let cashSub, cashCommission;

    await t.test('1. Cash delivery accrues 0.5% of the invoice as due', async () => {
      cashSub = await placeOrder(merchant, 1);
      assert.equal(cashSub.payment_method, 'cash');
      await deliver(merchant, supplier, driver, cashSub, { collection: cashSub.total });

      cashCommission = Math.round(cashSub.total * 0.005);
      const account = (await request('/api/commissions', { cookie: supplier })).data;
      assert.equal(account.rate_bps, 50);
      assert.equal(account.total_sales, cashSub.total);
      assert.equal(account.total_commission, cashCommission);
      assert.equal(account.due_commission, cashCommission);
      assert.equal(account.settled_commission, 0);
      assert.equal(account.net_sales, cashSub.total - cashCommission);
      assert.equal(account.rows[0].status, 'due');

      const revenue = rawDb.prepare("SELECT sum(l.credit) c FROM ledger_lines l JOIN ledger_accounts a ON a.id=l.account_id WHERE a.code='COMMISSION_PLATFORM'").get().c;
      assert.equal(revenue, cashCommission);
      assertBooksBalance();
    });

    await t.test('2. Commissions are private to each supplier and hidden from other roles', async () => {
      const other = (await request('/api/commissions', { cookie: supplier2 })).data;
      assert.equal(other.total_commission, 0);
      assert.equal(other.rows.length, 0);
      await request('/api/commissions', { cookie: merchant, status: 403 });
      await request('/api/commissions', { cookie: driver, status: 403 });
      await request('/api/commissions/settle', { cookie: admin, body: { amount: cashCommission, wallet: WALLET }, status: 403 });
    });

    await t.test('3. Supplier settles the exact due amount once', async () => {
      await request('/api/commissions/settle', { cookie: supplier, body: { amount: cashCommission + 1, wallet: WALLET }, status: 409 });
      await request('/api/commissions/settle', { cookie: supplier, body: { amount: cashCommission, wallet: '123' }, status: 422 });
      const { data } = await request('/api/commissions/settle', { cookie: supplier, body: { amount: cashCommission, wallet: WALLET } });
      assert.equal(data.amount, cashCommission);
      await request('/api/commissions/settle', { cookie: supplier, body: { amount: cashCommission, wallet: WALLET }, status: 422 });

      const account = (await request('/api/commissions', { cookie: supplier })).data;
      assert.equal(account.due_commission, 0);
      assert.equal(account.settled_commission, cashCommission);
      assert.equal(account.rows[0].settled_via, 'wallet');
      assertBooksBalance();
    });

    await t.test('4. Sham Cash captures on delivery and deducts the commission at source', async () => {
      const sub = await placeOrder(merchant, 3, { payment_method: 'sham_cash', wallet: WALLET });
      assert.equal(sub.payment_method, 'sham_cash');
      assert.equal(sub.wallet_ref, '09••••5678');
      assert.equal(rawDb.prepare('SELECT count(*) n FROM payments WHERE suborder_id=?').get(sub.id).n, 0);

      await deliver(merchant, supplier, driver, sub);

      const invoice = (await request('/api/ledger/invoices', { cookie: merchant })).data.find(i => i.suborder_id === sub.id);
      assert.equal(invoice.status, 'paid');
      assert.equal(invoice.paid_amount, sub.total);

      const payment = rawDb.prepare('SELECT * FROM payments WHERE suborder_id=?').get(sub.id);
      assert.equal(payment.payment_method, 'sham_cash');
      assert.equal(payment.amount, sub.total);
      assert.equal(rawDb.prepare('SELECT count(*) n FROM collections WHERE suborder_id=?').get(sub.id).n, 0);

      const row = (await request('/api/commissions', { cookie: supplier })).data.rows.find(c => c.suborder_id === sub.id);
      assert.equal(row.amount, Math.round(sub.total * 0.005));
      assert.equal(row.status, 'settled');
      assert.equal(row.settled_via, 'deducted');
      assertBooksBalance();

      const statement = (await request('/api/ledger/statement', { cookie: merchant })).data;
      assert.ok(statement.payments.some(p => p.payment_method === 'sham_cash'));
    });

    await t.test('5. Rejected Sham Cash order is never charged', async () => {
      const sub = await placeOrder(merchant, 5, { payment_method: 'sham_cash', wallet: WALLET });
      await request(`/api/suborders/${sub.id}/action`, { cookie: supplier, body: { action: 'reject', note: 'نفد المخزون' } });
      assert.equal(rawDb.prepare('SELECT count(*) n FROM payments WHERE suborder_id=?').get(sub.id).n, 0);
      assert.equal(rawDb.prepare('SELECT count(*) n FROM platform_commissions WHERE suborder_id=?').get(sub.id).n, 0);
    });

    await t.test('6. Invalid payment input is refused before creating an order', async () => {
      const quote = (await request('/api/quotes', { cookie: merchant, body: { zone: 'دمشق', address: 'دمشق', items: [{ listing_id: 1, quantity: 1 }] } })).data;
      const attempt = (body, key) => request('/api/orders', { cookie: merchant, body: { quote_id: quote.id, ...body }, headers: { 'Idempotency-Key': key }, status: 422 });
      await attempt({ payment_method: 'sham_cash' }, 'bad-1');
      await attempt({ payment_method: 'bitcoin' }, 'bad-2');
    });

    await t.test('7. Admin overview totals platform revenue by supplier', async () => {
      const overview = (await request('/api/commissions', { cookie: admin })).data;
      const account = (await request('/api/commissions', { cookie: supplier })).data;
      assert.equal(overview.total_commission, account.total_commission);
      assert.equal(overview.settled_commission, account.settled_commission);
      assert.equal(overview.suppliers.find(s => s.id === 1).invoices_count, 2);
    });

    await t.test('8. A pre-Sham-Cash database is migrated with its payments intact', async () => {
      await stop();
      rawDb.exec(`PRAGMA foreign_keys=OFF;
        CREATE TABLE payments_old(id INTEGER PRIMARY KEY,receipt_number TEXT NOT NULL UNIQUE,payer_id INTEGER NOT NULL REFERENCES users(id),supplier_id INTEGER NOT NULL REFERENCES suppliers(id),amount INTEGER NOT NULL CHECK(amount > 0),unallocated_amount INTEGER NOT NULL DEFAULT 0,currency TEXT NOT NULL DEFAULT 'SYP',payment_method TEXT NOT NULL DEFAULT 'cash' CHECK(payment_method IN ('cash','bank_transfer','settlement_credit','manual_adjustment')),collected_by_role TEXT NOT NULL CHECK(collected_by_role IN ('driver','supplier','admin')),collected_by_id INTEGER NOT NULL REFERENCES users(id),suborder_id INTEGER REFERENCES suborders(id),memo TEXT NOT NULL DEFAULT '',idempotency_key TEXT UNIQUE,status TEXT NOT NULL DEFAULT 'recorded',created TEXT NOT NULL);
        INSERT INTO payments_old SELECT * FROM payments WHERE payment_method<>'sham_cash';
        DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM payments WHERE payment_method='sham_cash');
        DROP TABLE payments;
        ALTER TABLE payments_old RENAME TO payments;
        PRAGMA foreign_keys=ON;`);
      const before = rawDb.prepare('SELECT * FROM payments ORDER BY id').all();
      assert.ok(before.length >= 1);

      await start();
      const after = rawDb.prepare('SELECT * FROM payments ORDER BY id').all();
      assert.deepEqual(after, before);
      assert.equal(rawDb.prepare('PRAGMA foreign_key_check').all().length, 0);
      assert.ok(rawDb.prepare("SELECT sql FROM sqlite_master WHERE name='payments'").get().sql.includes('sham_cash'));

      const merchantAgain = await login('merchant');
      const supplierAgain = await login('supplier');
      const driverAgain = await login('driver');
      const sub = await placeOrder(merchantAgain, 7, { payment_method: 'sham_cash', wallet: WALLET });
      await deliver(merchantAgain, supplierAgain, driverAgain, sub);
      assert.equal(rawDb.prepare('SELECT payment_method FROM payments WHERE suborder_id=?').get(sub.id).payment_method, 'sham_cash');
    });

    await t.test('9. Simulated payments are refused outside demo mode', async () => {
      await stop();
      await start({ DEMO_MODE: '0', ADMIN_PASSWORD: 'a-unique-long-password' }, join(dir, 'pilot.sqlite'));
      const secret = 'PilotMerchant2026!';
      await request('/api/register', { body: { name: 'محل', email: 'pilot@example.com', password: secret } });
      const { response } = await request('/api/login', { body: { email: 'pilot@example.com', password: secret } });
      const cookie = response.headers.get('set-cookie').split(';')[0];
      const refused = await request('/api/orders', {
        cookie,
        body: { quote_id: 'any', payment_method: 'sham_cash', wallet: WALLET },
        headers: { 'Idempotency-Key': 'pilot-1' },
        status: 422
      });
      assert.match(refused.data.error, /بيئة العرض/);
    });
  } finally {
    rawDb.close();
    await stop();
  }
});
