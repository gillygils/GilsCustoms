'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

// A stand-in for Cloudflare's siteverify endpoint. Tokens are single-use like
// the real thing; the token text decides the hostname/action it reports.
const verifyCalls = [];
const usedTokens = new Set();
let siteverifyDown = false;
const fakeCloudflare = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (siteverifyDown) {
      res.statusCode = 503;
      return res.end('unavailable');
    }
    const params = new URLSearchParams(body);
    const token = params.get('response');
    verifyCalls.push(Object.fromEntries(params));
    const replay = usedTokens.has(token);
    usedTokens.add(token);
    const good = token.startsWith('good-') && params.get('secret') === 'test-secret' && !replay;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        success: good,
        'error-codes': good ? [] : [replay ? 'timeout-or-duplicate' : 'invalid-input-response'],
        hostname: token.includes('other-site') ? 'evil.example' : 'gilscustoms.com',
        action: token.includes('other-action') ? 'login' : 'contact',
      })
    );
  });
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gilscustoms-turnstile-'));
let server;
let base;
let ipCounter = 0;

before(async () => {
  fakeCloudflare.listen(0);
  await new Promise((r) => fakeCloudflare.once('listening', r));
  Object.assign(process.env, {
    DATA_DIR: dataDir,
    TURNSTILE_SECRET_KEY: 'test-secret',
    TURNSTILE_VERIFY_URL: `http://127.0.0.1:${fakeCloudflare.address().port}/siteverify`,
  });
  delete process.env.TURNSTILE_SITE_KEY;
  delete process.env.TURNSTILE_HOSTNAMES;
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

// Each call uses its own visitor IP so the rate limit doesn't interfere.
function post(extra, headers = {}) {
  const fd = new FormData();
  const fields = { name: 'Test', email: 'test@example.com', year: '2015', message: 'Hello', started_at: '0', ...extra };
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fetch(`${base}/api/contact`, {
    method: 'POST',
    body: fd,
    headers: { Accept: 'application/json', 'CF-Connecting-IP': `198.51.100.${++ipCounter}`, ...headers },
  });
}

function saved() {
  const file = path.join(dataDir, 'submissions.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
}

test('both forms carry the built-in Gils Customs site key', async () => {
  for (const page of ['/', '/contact-us']) {
    const html = await (await fetch(base + page)).text();
    assert.match(html, /<div class="cf-turnstile" data-sitekey="0x4AAAAAAFtIJ4PiRVSJ107w"><\/div>/, page);
    assert.doesNotMatch(html, /__TURNSTILE_SITE_KEY__|test-secret/, page);
  }
});

test('rejects missing, invalid and oversized tokens', async () => {
  for (const extra of [{}, { 'cf-turnstile-response': 'bot-token' }, { 'cf-turnstile-response': 'good-' + 'x'.repeat(2050) }]) {
    const res = await post(extra);
    assert.strictEqual(res.status, 403);
    assert.match((await res.json()).message, /spam check/);
  }
});

test('rejects passes earned on another site or by another form', async () => {
  assert.strictEqual((await post({ 'cf-turnstile-response': 'good-other-site' })).status, 403);
  assert.strictEqual((await post({ 'cf-turnstile-response': 'good-other-action' })).status, 403);
});

test('accepts a fresh pass once, checked against the visitor IP, and rejects a replay', async () => {
  const before = saved().length;
  let res = await post({ 'cf-turnstile-response': 'good-1' }, { 'CF-Connecting-IP': '203.0.113.7' });
  assert.strictEqual(res.status, 200);
  const last = verifyCalls.at(-1);
  assert.strictEqual(last.secret, 'test-secret');
  assert.strictEqual(last.remoteip, '203.0.113.7');
  assert.strictEqual(saved().at(-1).ip, '203.0.113.7');

  res = await post({ 'cf-turnstile-response': 'good-1' });
  assert.strictEqual(res.status, 403, 'the same token must not work twice');
  assert.strictEqual(saved().length, before + 1, 'only the first submission is saved');
});

test('fails closed when Cloudflare cannot be reached', async () => {
  siteverifyDown = true;
  try {
    assert.strictEqual((await post({ 'cf-turnstile-response': 'good-2' })).status, 403);
  } finally {
    siteverifyDown = false;
  }
});
