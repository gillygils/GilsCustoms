'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gilscustoms-test-'));
process.env.DATA_DIR = dataDir;
delete process.env.SMTP_HOST;

const app = require('../server');

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function form(fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

function post(fields, ip, accept = 'application/json') {
  return fetch(`${base}/api/contact`, {
    method: 'POST',
    body: fields instanceof FormData ? fields : form(fields),
    headers: { Accept: accept, 'X-Forwarded-For': ip },
    redirect: 'manual',
  });
}

const valid = {
  name: 'Test Person',
  email: 'test@example.com',
  year: '2015',
  vehicle: 'Ford F-150',
  message: 'I want sequential turn signals.',
  started_at: '0',
};

function submissions() {
  const file = path.join(dataDir, 'submissions.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

test('serves the main pages', async () => {
  for (const p of ['/', '/service', '/faq', '/contact-us', '/thanks']) {
    const res = await fetch(base + p);
    assert.strictEqual(res.status, 200, p);
  }
  assert.strictEqual((await fetch(`${base}/does-not-exist`)).status, 404);
});

test('redirects old Wix URLs', async () => {
  const res = await fetch(`${base}/category/shop`, { redirect: 'manual' });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get('location'), '/service');
});

test('accepts a valid submission and saves it', async () => {
  const res = await post(valid, '10.0.0.1');
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).ok, true);
  const last = submissions().at(-1);
  assert.strictEqual(last.email, 'test@example.com');
  assert.strictEqual(last.year, '2015');
  assert.strictEqual(last.vehicle, 'Ford F-150');
});

test('redirects to /thanks for non-JS form posts', async () => {
  const res = await post(valid, '10.0.0.2', 'text/html');
  assert.strictEqual(res.status, 303);
  assert.strictEqual(res.headers.get('location'), '/thanks');
});

test('rejects missing or invalid fields', async () => {
  let res = await post({ ...valid, email: 'not-an-email' }, '10.0.0.3');
  assert.strictEqual(res.status, 400);
  res = await post({ ...valid, message: '   ' }, '10.0.0.3');
  assert.strictEqual(res.status, 400);
  res = await post({ ...valid, name: '' }, '10.0.0.3');
  assert.strictEqual(res.status, 400);
});

test('requires a sensible vehicle year', async () => {
  const bad = ['', '15', '20155', 'abcd', '1850', String(new Date().getFullYear() + 5)];
  for (const [i, year] of bad.entries()) {
    const res = await post({ ...valid, year }, `10.0.1.${i}`);
    assert.strictEqual(res.status, 400, `year "${year}" should be rejected`);
    assert.match((await res.json()).message, /year/);
  }
  const { year, ...noYear } = valid;
  assert.strictEqual((await post(noYear, '10.0.0.8')).status, 400);
  assert.strictEqual((await post({ ...valid, year: '1967' }, '10.0.0.8')).status, 200);
});

test('silently drops honeypot and too-fast submissions', async () => {
  const before = submissions().length;
  let res = await post({ ...valid, website: 'http://spam.example' }, '10.0.0.4');
  assert.strictEqual(res.status, 200);
  res = await post({ ...valid, started_at: String(Date.now()) }, '10.0.0.4');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(submissions().length, before);
});

test('saves attached photos', async () => {
  const fd = form(valid);
  fd.append('photos', new Blob([Buffer.from([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }), 'my car.jpg');
  const res = await post(fd, '10.0.0.5');
  assert.strictEqual(res.status, 200);
  const last = submissions().at(-1);
  assert.deepStrictEqual(last.photos, ['1-my_car.jpg']);
  assert.ok(fs.existsSync(path.join(dataDir, 'uploads', last.id, '1-my_car.jpg')));
});

test('rate limits repeated submissions from one IP', async () => {
  const statuses = [];
  for (let i = 0; i < 7; i++) statuses.push((await post(valid, '10.0.0.6')).status);
  assert.deepStrictEqual(statuses.slice(0, 5), [200, 200, 200, 200, 200]);
  assert.strictEqual(statuses[5], 429);
});

test('pages link versioned CSS/JS and allow edge caching', async () => {
  const res = await fetch(`${base}/`);
  assert.match(res.headers.get('cache-control'), /s-maxage=3600/);
  const html = await res.text();
  const css = html.match(/\/css\/style\.css\?v=([0-9a-f]{10})"/);
  assert.ok(css, 'style.css should carry a version');
  assert.match(html, new RegExp(`/js/main\\.js\\?v=${css[1]}"`));

  const asset = await fetch(`${base}/css/style.css?v=${css[1]}`);
  assert.strictEqual(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const unversioned = await fetch(`${base}/css/style.css`);
  assert.strictEqual(unversioned.headers.get('cache-control'), 'public, max-age=3600');
});

test('caches fonts and images', async () => {
  const font = await fetch(`${base}/fonts/sora-latin.woff2`);
  assert.strictEqual(font.status, 200);
  assert.strictEqual(font.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const img = await fetch(`${base}/img/logo.webp`);
  assert.strictEqual(img.status, 200);
  assert.strictEqual(img.headers.get('cache-control'), 'public, max-age=2592000');
});

test('redirects .html URLs to clean ones and serves the 404 page', async () => {
  let res = await fetch(`${base}/faq.html`, { redirect: 'manual' });
  assert.strictEqual(res.headers.get('location'), '/faq');
  res = await fetch(`${base}/index.html`, { redirect: 'manual' });
  assert.strictEqual(res.headers.get('location'), '/');
  res = await fetch(`${base}/nope`);
  assert.strictEqual(res.status, 404);
  assert.match(await res.text(), /Page not found/);
  assert.strictEqual(res.headers.get('cache-control'), 'no-store');
});
