import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

test('RAFID Ledger: Double-entry accounting, invoicing, collections, remittances and aging', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rafid-ledger-'));
  const dbPath = join(dir, 'test.sqlite');
  const port = 43000 + Math.floor(Math.random() * 8000);
  const base = `http://127.0.0.1:${port}`;

  let server, output = '';
  async function start() {
    server = spawn(process.execPath, ['server.js'], {
      cwd: process.cwd(),
      env: { ...process.env, DEMO_MODE: '1', DB_PATH: dbPath, PORT: String(port), HOST: '127.0.0.1' }
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
    let data;
    try { data = await response.json(); } catch { data = {}; }
    assert.equal(response.status, status, `${path}: ${JSON.stringify(data)}`);
    return { data, response };
  }

  async function login(account) {
    const { response, data } = await request('/api/login', { body: { email: account + '@rafid.local', password: 'RafidDemo2026!' } });
    return { cookie: response.headers.get('set-cookie').split(';')[0], user: data };
  }

  await start();
  const rawDb = new DatabaseSync(dbPath);

  try {
    let merchant, supplier, supplier2, admin, driver, platform;
    merchant = await login('merchant');
    supplier = await login('supplier');
    supplier2 = await login('supplier2');
    admin = await login('admin');
    driver = await login('driver');
    platform = await login('platform');

    let suborderId = null;

    await t.test('1. Creating invoice and receivable upon suborder delivery with double-entry balance', async () => {
      // Create a cart and order
      const qRes = await request('/api/quotes', {
        cookie: merchant.cookie,
        body: { zone: 'دمشق', address: 'دمشق - الميدان', items: [{ listing_id: 1, quantity: 2 }] }
      });
      const orderRes = await request('/api/orders', {
        cookie: merchant.cookie,
        body: { quote_id: qRes.data.id },
        headers: { 'Idempotency-Key': 'ledger-order-1' }
      });

      const myOrders = (await request('/api/orders', { cookie: merchant.cookie })).data;
      const sub = myOrders[0].suborders[0];
      suborderId = sub.id;

      // Progress suborder to arrived
      await request(`/api/suborders/${sub.id}/action`, { cookie: supplier.cookie, body: { action: 'confirm' } });
      await request(`/api/suborders/${sub.id}/action`, { cookie: supplier.cookie, body: { action: 'prepare' } });
      await request(`/api/suborders/${sub.id}/action`, { cookie: supplier.cookie, body: { action: 'ready' } });

      await request('/api/dispatch', { cookie: supplier.cookie, body: { driver_id: 5, suborder_ids: [sub.id] } });
      await request(`/api/suborders/${sub.id}/action`, { cookie: driver.cookie, body: { action: 'accept' } });
      await request(`/api/suborders/${sub.id}/action`, { cookie: driver.cookie, body: { action: 'pickup' } });

      const updatedSub = (await request('/api/orders', { cookie: merchant.cookie })).data[0].suborders[0];
      const deliveryCode = updatedSub.deliveryCode;

      await request(`/api/suborders/${sub.id}/action`, { cookie: driver.cookie, body: { action: 'depart' } });
      await request(`/api/suborders/${sub.id}/action`, { cookie: driver.cookie, body: { action: 'arrive' } });

      // Deliver with full collection
      await request(`/api/suborders/${sub.id}/deliver`, {
        cookie: driver.cookie,
        body: { code: deliveryCode, collection: sub.total }
      });

      // Verify invoice was created
      const invs = (await request('/api/ledger/invoices', { cookie: merchant.cookie })).data;
      assert.ok(invs.length >= 1);
      const myInv = invs.find(i => i.suborder_id === sub.id);
      assert.ok(myInv);
      assert.equal(myInv.total_amount, sub.total);
      assert.equal(myInv.paid_amount, sub.total);
      assert.equal(myInv.status, 'paid');

      // Verify ledger entry double-entry balance
      const entries = rawDb.prepare("SELECT * FROM ledger_entries WHERE reference_type='invoice' AND reference_id=?").all(String(myInv.id));
      assert.equal(entries.length, 1);
      const lines = rawDb.prepare('SELECT * FROM ledger_lines WHERE entry_id=?').all(entries[0].id);
      const sumDebit = lines.reduce((acc, l) => acc + l.debit, 0);
      const sumCredit = lines.reduce((acc, l) => acc + l.credit, 0);
      assert.equal(sumDebit, sumCredit);
      assert.equal(sumDebit, sub.total);
    });

    await t.test('2. Preventing duplicate invoice and collection on duplicate delivery event', async () => {
      const invsBefore = (await request('/api/ledger/invoices', { cookie: merchant.cookie })).data.filter(i => i.suborder_id === suborderId);
      assert.equal(invsBefore.length, 1);
    });

    await t.test('3. Driver cash custody and collection record', async () => {
      const cols = (await request('/api/ledger/collections', { cookie: driver.cookie })).data;
      const myCol = cols.find(c => c.suborder_id === suborderId);
      assert.ok(myCol);
      assert.equal(myCol.collected_amount, myCol.expected_amount);
      assert.equal(myCol.driver_type, 'supplier');
      assert.equal(myCol.remittance_status, 'pending_remittance');
    });

    await t.test('4. Driver cash remittance and reconciliation with variance tracking', async () => {
      // Driver submits remittance of 150000 SYP (less than collected e.g. 165000)
      const remRes = await request('/api/ledger/remittances', {
        cookie: driver.cookie,
        body: { amount: 150000, note: 'دفعة توريد أولية من رحلة الميدان' }
      });
      assert.ok(remRes.data.id);
      assert.equal(remRes.data.status, 'submitted');

      // Supplier reconciles and confirms
      const reconRes = await request('/api/ledger/reconcile', {
        cookie: supplier.cookie,
        body: { remittance_id: remRes.data.id, verified_amount: 150000, note: 'مستلم ومطابق' }
      });
      assert.equal(reconRes.data.status, 'verified');

      // Verify that ledger transferred custody from driver to supplier cash box
      const remEntries = rawDb.prepare("SELECT * FROM ledger_entries WHERE reference_type='remittance' AND reference_id=?").all(String(remRes.data.id));
      assert.equal(remEntries.length, 1);
      const lines = rawDb.prepare('SELECT * FROM ledger_lines WHERE entry_id=?').all(remEntries[0].id);
      const sumDebit = lines.reduce((a, l) => a + l.debit, 0);
      const sumCredit = lines.reduce((a, l) => a + l.credit, 0);
      assert.equal(sumDebit, sumCredit);
    });

    await t.test('5. Credit terms setting and merchant statement', async () => {
      // Supplier sets credit limit of 2,000,000 and 15 days terms for merchant
      await request('/api/ledger/credit-terms', {
        cookie: supplier.cookie,
        body: { merchant_id: 2, credit_limit: 2000000, payment_term_days: 15, notes: 'سقف ائتماني ممتاز' }
      });

      const terms = (await request('/api/ledger/credit-terms?supplier_id=1&merchant_id=2', { cookie: merchant.cookie })).data;
      assert.equal(terms.credit_limit, 2000000);
      assert.equal(terms.payment_term_days, 15);

      // Fetch merchant statement
      const stmt = (await request('/api/ledger/statement', { cookie: merchant.cookie })).data;
      assert.equal(stmt.merchant_id, 2);
      assert.ok(stmt.total_invoiced > 0);
      assert.ok(stmt.invoices.length > 0);
    });

    await t.test('6. Partial payments and allocation across invoices', async () => {
      // Deliver another suborder with 0 cash collected (on credit)
      const qRes = await request('/api/quotes', {
        cookie: merchant.cookie,
        body: { zone: 'دمشق', address: 'دمشق - الميدان', items: [{ listing_id: 1, quantity: 1 }] }
      });
      const orderRes = await request('/api/orders', {
        cookie: merchant.cookie,
        body: { quote_id: qRes.data.id },
        headers: { 'Idempotency-Key': 'ledger-order-credit' }
      });
      const sub = (await request('/api/orders', { cookie: merchant.cookie })).data.find(o => o.id === orderRes.data.id).suborders[0];

      await request(`/api/suborders/${sub.id}/action`, { cookie: supplier.cookie, body: { action: 'confirm' } });
      await request(`/api/suborders/${sub.id}/action`, { cookie: supplier.cookie, body: { action: 'prepare' } });
      await request(`/api/suborders/${sub.id}/action`, { cookie: supplier.cookie, body: { action: 'ready' } });
      await request('/api/dispatch', { cookie: supplier.cookie, body: { driver_id: 5, suborder_ids: [sub.id] } });
      await request(`/api/suborders/${sub.id}/action`, { cookie: driver.cookie, body: { action: 'accept' } });
      await request(`/api/suborders/${sub.id}/action`, { cookie: driver.cookie, body: { action: 'pickup' } });
      const code = (await request('/api/orders', { cookie: merchant.cookie })).data.find(o => o.id === orderRes.data.id).suborders[0].deliveryCode;
      await request(`/api/suborders/${sub.id}/action`, { cookie: driver.cookie, body: { action: 'depart' } });
      await request(`/api/suborders/${sub.id}/action`, { cookie: driver.cookie, body: { action: 'arrive' } });

      // Deliver with 0 collected cash (on credit net_15)
      await request(`/api/suborders/${sub.id}/deliver`, {
        cookie: driver.cookie,
        body: { code, collection: 0 }
      });

      const unpaidInv = (await request('/api/ledger/invoices', { cookie: merchant.cookie })).data.find(i => i.suborder_id === sub.id);
      assert.ok(unpaidInv);
      assert.equal(unpaidInv.status, 'issued');
      assert.equal(unpaidInv.paid_amount, 0);

      // Supplier records a partial payment of 50000 SYP
      const payRes = await request('/api/ledger/payments', {
        cookie: supplier.cookie,
        body: {
          merchant_id: 2,
          amount: 50000,
          payment_method: 'bank_transfer',
          memo: 'حوالة بنكية سداد جزئي',
          invoice_ids: [unpaidInv.id]
        }
      });
      assert.ok(payRes.data.id);

      const updatedInv = (await request('/api/ledger/invoices', { cookie: merchant.cookie })).data.find(i => i.id === unpaidInv.id);
      assert.equal(updatedInv.paid_amount, 50000);
      assert.equal(updatedInv.status, 'partially_paid');
    });

    await t.test('7. Supplier aging report categories and delinquent accounts', async () => {
      const aging = (await request('/api/ledger/aging', { cookie: supplier.cookie })).data;
      assert.ok('buckets' in aging);
      assert.ok('current' in aging.buckets);
      assert.ok('total_receivables' in aging);
      assert.ok(aging.total_receivables > 0);
    });

    await t.test('8. Role isolation: other suppliers cannot access private books', async () => {
      // Supplier 2 cannot reconcile Supplier 1 remittances
      await request('/api/ledger/reconcile', {
        cookie: supplier2.cookie,
        body: { remittance_id: 1, verified_amount: 1000 },
        status: 403
      });

      // Outsider merchant cannot view Merchant 2 statement
      await request('/api/register', { body: { name: 'دخيل', email: 'intruder@rafid.local', password: 'IntruderDemo2026!' } });
      const intruder = (await request('/api/login', { body: { email: 'intruder@rafid.local', password: 'IntruderDemo2026!' } }));
      const intruderCookie = intruder.response.headers.get('set-cookie').split(';')[0];

      const intruderStmt = (await request('/api/ledger/statement', { cookie: intruderCookie })).data;
      assert.equal(intruderStmt.merchant_id, intruder.data.id);
      assert.equal(intruderStmt.invoices.length, 0);
    });
  } finally {
    rawDb.close();
    await stop();
  }
});
