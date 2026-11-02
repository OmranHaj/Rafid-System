import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

test('RAFID Pro: Business intelligence, subscriptions, privacy protection, and CSV export', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rafid-pro-'));
  const dbPath = join(dir, 'test.sqlite');
  const port = 45000 + Math.floor(Math.random() * 8000);
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
    const merchant = await login('merchant');
    const supplier = await login('supplier');
    const supplier2 = await login('supplier2');
    const admin = await login('admin');
    const driver = await login('driver');

    await t.test('1. Free tier account cannot access Pro overview without active subscription', async () => {
      // In demo mode, supplier 1 and merchant have demo trial, but supplier2 does not
      const sub2 = (await request('/api/pro/subscription', { cookie: supplier2.cookie })).data;
      assert.equal(sub2.is_pro, false);
      assert.equal(sub2.plan_id, 'free');

      // Attempting to access overview without Pro returns 403
      await request('/api/pro/overview', {
        cookie: supplier2.cookie,
        status: 403
      });
    });

    await t.test('2. Admin can activate and renew Pro subscriptions', async () => {
      // Admin activates Pro for Supplier 2
      const actRes = await request('/api/admin/subscriptions', {
        cookie: admin.cookie,
        body: {
          entity_type: 'supplier',
          entity_id: 2,
          plan_id: 'pro',
          duration_days: 60,
          notes: 'اشتراك مدفوع بشيك'
        }
      });
      assert.equal(actRes.data.status, 'active');
      assert.equal(actRes.data.plan_id, 'pro');

      // Now supplier2 has Pro access
      const sub2After = (await request('/api/pro/subscription', { cookie: supplier2.cookie })).data;
      assert.equal(sub2After.is_pro, true);
      assert.equal(sub2After.plan_id, 'pro');

      const overview = (await request('/api/pro/overview', { cookie: supplier2.cookie })).data;
      assert.ok('performance' in overview);
      assert.ok('top_products' in overview);
    });

    await t.test('3. Aggregations calculation upon order delivery', async () => {
      // Create and deliver order for Supplier 1
      const qRes = await request('/api/quotes', {
        cookie: merchant.cookie,
        body: { zone: 'دمشق', address: 'دمشق - الميدان', items: [{ listing_id: 1, quantity: 4 }] }
      });
      const orderRes = await request('/api/orders', {
        cookie: merchant.cookie,
        body: { quote_id: qRes.data.id },
        headers: { 'Idempotency-Key': 'pro-order-1' }
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

      await request(`/api/suborders/${sub.id}/deliver`, {
        cookie: driver.cookie,
        body: { code, collection: sub.total }
      });

      // Fetch Supplier Pro Overview
      const supOverview = (await request('/api/pro/overview?days=30', { cookie: supplier.cookie })).data;
      assert.ok(supOverview.performance.delivered_orders >= 1);
      assert.ok(supOverview.performance.revenue > 0);

      // Verify top products list
      const topProd = supOverview.top_products.find(p => p.product_id === 1);
      assert.ok(topProd);
      assert.ok(topProd.units_sold >= 4);

      // Verify regional statistics
      assert.ok(supOverview.regions.length >= 1);
      const damascus = supOverview.regions.find(r => r.zone === 'دمشق');
      assert.ok(damascus);
      assert.ok(damascus.units_sold >= 4);
    });

    await t.test('4. Competitor privacy protection: benchmark suppressed when sample < 5 suppliers', async () => {
      // In our platform, there are only 2 suppliers (< 5)
      const supOverview = (await request('/api/pro/overview?days=30', { cookie: supplier.cookie })).data;
      assert.ok('market_benchmark' in supOverview);
      assert.equal(supOverview.market_benchmark.benchmark_available, false);
      assert.equal(supOverview.market_benchmark.reason, 'insufficient_competitor_sample');
      assert.ok(supOverview.market_benchmark.message.includes('حماية لسرية بيانات الموردين'));
    });

    await t.test('5. Merchant Pro overview: spending intelligence and smart alerts', async () => {
      const merOverview = (await request('/api/pro/overview?days=30', { cookie: merchant.cookie })).data;
      assert.ok('summary' in merOverview);
      assert.ok(merOverview.summary.total_spend > 0);
      assert.ok(merOverview.top_spent_products.length >= 1);
      assert.ok(Array.isArray(merOverview.smart_alerts));
    });

    await t.test('6. CSV Export security: UTF-8 BOM and formula injection protection', async () => {
      const resp = await fetch(`${base}/api/pro/export?type=top_products`, {
        headers: { Cookie: supplier.cookie }
      });
      assert.equal(resp.status, 200);
      assert.equal(resp.headers.get('content-type'), 'text/csv; charset=utf-8');

      const arrayBuf = await resp.arrayBuffer();
      const bytes = new Uint8Array(arrayBuf);
      // Byte-level verification: Starts with UTF-8 BOM (0xEF, 0xBB, 0xBF)
      assert.equal(bytes[0], 0xEF);
      assert.equal(bytes[1], 0xBB);
      assert.equal(bytes[2], 0xBF);

      const csvText = new TextDecoder('utf-8').decode(bytes);
      // Verify CSV headers
      assert.ok(csvText.includes('name') || csvText.includes('المنتج') || csvText.includes('units_sold'));

      // Test CSV formula injection sanitization directly via engine
      const { createAnalyticsEngine } = await import('../analytics.js');
      const engine = createAnalyticsEngine({
        db: rawDb,
        need: () => {},
        int: v => v,
        str: v => v,
        fail: () => {},
        transaction: fn => fn(),
        audit: () => {},
        now: () => new Date().toISOString()
      });

      const dangerousRows = [
        { name: "=cmd|'/C calc'!A0", brand: "+sum(1,2)", note: "-danger", email: "@domain.com", normal: "123" }
      ];
      const exportedCsv = engine.exportReportCsv('test', dangerousRows);
      // Neutralized with single quote
      assert.ok(exportedCsv.includes("''=cmd") || exportedCsv.includes("'=cmd"));
      assert.ok(exportedCsv.includes("'+sum"));
      assert.ok(exportedCsv.includes("'-danger"));
      assert.ok(exportedCsv.includes("'@domain.com"));
    });

    await t.test('7. Unauthorized roles (driver, guest) cannot access Pro overview', async () => {
      await request('/api/pro/overview', { cookie: driver.cookie, status: 403 });
      await request('/api/pro/overview', { status: 401 });
    });
  } finally {
    rawDb.close();
    await stop();
  }
});
