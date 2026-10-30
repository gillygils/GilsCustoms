'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

// A stand-in for Cloudflare's siteverify endpoint: only "good-token" passes.
const verifyCalls = [];
const fakeCloudflare = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const params = new URLSearchParams(body);
    verifyCalls.push(Object.fromEntries(params));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: params.get('response') === 'good-token' }));
  });
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gilscustoms-turnstile-'));
let server;
let base;

before(async () => {
  fakeCloudflare.listen(0);
  await new Promise((r) => fakeCloudflare.once('listening', r));
  Object.assign(process.env, {
    DATA_DIR: dataDir,
    TURNSTILE_SITE_KEY: 'test-site-key',
    TURNSTILE_SECRET_KEY: 'test-secret',
    TURNSTILE_VERIFY_URL: `http://127.0.0.1:${fakeCloudflare.address().port}/siteverify`,
  });
  delete process.env.SMTP_HOST;

  const app = require('../server');
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fakeCloudflare.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function post(extra, headers = {}) {
  const fd = new FormData();
  const fields = { name: 'Test', email: 'test@example.com', year: '2015', message: 'Hello', started_at: '0', ...extra };
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fetch(`${base}/api/contact`, { method: 'POST', body: fd, headers: { Accept: 'application/json', ...headers } });
}

test('forms carry the Turnstile site key', async () => {
  for (const page of ['/', '/contact-us']) {
    const html = await (await fetch(base + page)).text();
    assert.match(html, /<div class="cf-turnstile" data-sitekey="test-site-key"><\/div>/, page);
    assert.doesNotMatch(html, /__TURNSTILE_SITE_KEY__/, page);
  }
});

test('rejects submissions without a passing spam check', async () => {
  let res = await post({});
  assert.strictEqual(res.status, 400);
  assert.match((await res.json()).message, /spam check/);

  res = await post({ 'cf-turnstile-response': 'bot-token' });
  assert.strictEqual(res.status, 400);
});

test('accepts submissions that pass, and checks them against the visitor IP', async () => {
  const res = await post({ 'cf-turnstile-response': 'good-token' }, { 'CF-Connecting-IP': '203.0.113.7' });
  assert.strictEqual(res.status, 200);
  const last = verifyCalls.at(-1);
  assert.strictEqual(last.secret, 'test-secret');
  assert.strictEqual(last.remoteip, '203.0.113.7');

  const saved = fs.readFileSync(path.join(dataDir, 'submissions.jsonl'), 'utf8').trim().split('\n');
  assert.strictEqual(saved.length, 1, 'only the passing submission is saved');
  assert.strictEqual(JSON.parse(saved[0]).ip, '203.0.113.7');
});
