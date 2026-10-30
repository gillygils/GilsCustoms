'use strict';

require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAIL_TO = process.env.MAIL_TO || 'david@gilscustoms.com';
const MAIL_FROM = process.env.MAIL_FROM || process.env.SMTP_USER || MAIL_TO;
const SEND_AUTO_REPLY = process.env.AUTO_REPLY === 'true';
// Cloudflare Turnstile spam check. Without both keys the forms work without it.
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || '';
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '';
const TURNSTILE_ENABLED = Boolean(TURNSTILE_SITE_KEY && TURNSTILE_SECRET_KEY);
const TURNSTILE_VERIFY_URL =
  process.env.TURNSTILE_VERIFY_URL || 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const MAX_PHOTOS = 4;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 5;
// Bots tend to submit instantly; people take at least a few seconds.
const MIN_FILL_TIME_MS = 3000;

const FIELD_LIMITS = {
  name: 100,
  email: 200,
  phone: 40,
  vehicle: 150,
  service: 100,
  heard: 100,
  message: 5000,
  source: 40,
};

fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

// ---------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------

const smtpConfigured = Boolean(process.env.SMTP_HOST);
const transporter = smtpConfigured
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    })
  : null;

if (!smtpConfigured) {
  console.warn(
    '[contact] SMTP_HOST is not set: form submissions will be saved to ' +
      path.join(DATA_DIR, 'submissions.jsonl') +
      ' but NOT emailed. See README.md to set up email.'
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Behind the Cloudflare Tunnel every request arrives from localhost, so use
// the visitor address Cloudflare passes along when it's there.
function clientIp(req) {
  return req.get('cf-connecting-ip') || req.ip;
}

async function passesTurnstile(token, ip) {
  if (!TURNSTILE_ENABLED) return true;
  if (typeof token !== 'string' || !token) return false;
  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      body: new URLSearchParams({ secret: TURNSTILE_SECRET_KEY, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    return data.success === true;
  } catch (e) {
    console.error('[contact] Turnstile check failed to run', e.message);
    return false;
  }
}

function clean(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n?/g, '\n').trim().slice(0, max);
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_LIMIT_MAX;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of hits) {
    if (times.every((t) => now - t >= RATE_LIMIT_WINDOW_MS)) hits.delete(ip);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

function wantsJson(req) {
  return (req.get('accept') || '').includes('application/json');
}

function reply(req, res, status, message) {
  if (wantsJson(req)) return res.status(status).json({ ok: status < 400, message });
  if (status < 400) return res.redirect(303, '/thanks');
  return res
    .status(status)
    .type('html')
    .send(
      `<!doctype html><meta charset="utf-8"><title>Message not sent</title>` +
        `<p style="font-family:sans-serif">${escapeHtml(message)}</p>` +
        `<p style="font-family:sans-serif"><a href="javascript:history.back()">Go back</a></p>`
    );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
// Behind Caddy / a tunnel, so trust the first proxy for the client IP.
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN',
  });
  next();
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: MAX_PHOTOS, fileSize: MAX_PHOTO_BYTES, fields: 20 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

app.post('/api/contact', (req, res) => {
  upload.array('photos', MAX_PHOTOS)(req, res, async (err) => {
    if (err) {
      const msg =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'One of your photos is over 8 MB. Please send smaller photos.'
          : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE'
            ? `Please attach no more than ${MAX_PHOTOS} photos.`
            : 'Something went wrong reading your message. Please try again.';
      return reply(req, res, 400, msg);
    }

    const body = req.body || {};

    // Honeypot: real visitors never see or fill this field.
    if (body.website) return reply(req, res, 200, 'Thanks!');
    const startedAt = Number(body.started_at);
    if (startedAt && Date.now() - startedAt < MIN_FILL_TIME_MS) {
      return reply(req, res, 200, 'Thanks!');
    }

    const ip = clientIp(req);
    if (rateLimited(ip)) {
      return reply(req, res, 429, 'Too many messages in a short time. Please try again in a few minutes.');
    }

    const f = {};
    for (const [key, max] of Object.entries(FIELD_LIMITS)) f[key] = clean(body[key], max);

    if (!f.name) return reply(req, res, 400, 'Please enter your name.');
    if (!EMAIL_RE.test(f.email)) return reply(req, res, 400, 'Please enter a valid email address.');
    if (!f.message) return reply(req, res, 400, 'Please tell us a little about your project.');

    if (!(await passesTurnstile(body['cf-turnstile-response'], ip))) {
      console.log(`[contact] rejected a submission that failed the spam check (${ip})`);
      return reply(
        req,
        res,
        400,
        `The spam check didn't pass. Please refresh the page and try again, or email ${MAIL_TO}.`
      );
    }

    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
    const photos = (req.files || []).map((file, i) => ({
      filename: `${i + 1}-${path.basename(file.originalname).replace(/[^\w.-]/g, '_').slice(-80)}`,
      content: file.buffer,
      contentType: file.mimetype,
    }));

    // Always keep a copy on disk so nothing is lost if email fails.
    try {
      if (photos.length) {
        const dir = path.join(DATA_DIR, 'uploads', id);
        fs.mkdirSync(dir, { recursive: true });
        for (const p of photos) fs.writeFileSync(path.join(dir, p.filename), p.content);
      }
      const record = { id, receivedAt: new Date().toISOString(), ip, ...f, photos: photos.map((p) => p.filename) };
      fs.appendFileSync(path.join(DATA_DIR, 'submissions.jsonl'), JSON.stringify(record) + '\n');
    } catch (e) {
      console.error('[contact] could not save submission', e);
    }

    if (!transporter) {
      console.log(`[contact] saved submission ${id} from ${f.email} (email not configured)`);
      return reply(req, res, 200, "Thanks! We'll get back to you soon.");
    }

    const rows = [
      ['Name', f.name],
      ['Email', f.email],
      ['Phone', f.phone],
      ['Vehicle', f.vehicle],
      ['Interested in', f.service],
      ['Heard about us', f.heard],
      ['Sent from', f.source],
    ].filter(([, v]) => v);

    const text =
      rows.map(([k, v]) => `${k}: ${v}`).join('\n') +
      `\n\nMessage:\n${f.message}\n\n` +
      (photos.length ? `${photos.length} photo(s) attached.\n` : '') +
      `Submission ID: ${id}`;

    const html =
      `<table cellpadding="6" style="border-collapse:collapse;font-family:sans-serif">` +
      rows.map(([k, v]) => `<tr><td><b>${escapeHtml(k)}</b></td><td>${escapeHtml(v)}</td></tr>`).join('') +
      `</table><p style="font-family:sans-serif;white-space:pre-wrap">${escapeHtml(f.message)}</p>` +
      `<p style="font-family:sans-serif;color:#888;font-size:12px">Submission ID: ${id}</p>`;

    try {
      await transporter.sendMail({
        from: { name: 'Gils Customs Website', address: MAIL_FROM },
        to: MAIL_TO,
        replyTo: { name: f.name, address: f.email },
        subject: `New build inquiry from ${f.name}${f.vehicle ? ` (${f.vehicle})` : ''}`,
        text,
        html,
        attachments: photos,
      });

      if (SEND_AUTO_REPLY) {
        await transporter
          .sendMail({
            from: { name: 'Gils Customs', address: MAIL_FROM },
            to: f.email,
            replyTo: MAIL_TO,
            subject: 'Thanks for reaching out to Gils Customs',
            text:
              `Hi ${f.name},\n\nThanks for reaching out! I got your message and will get back to you ` +
              `as soon as I can, usually within a day or two.\n\nIn the meantime, you can check out recent ` +
              `builds on Instagram (@gilscustoms) and YouTube (@GilsCustoms).\n\n- David, Gils Customs`,
          })
          .catch((e) => console.error('[contact] auto-reply failed', e.message));
      }
    } catch (e) {
      console.error(`[contact] email failed for ${id}; submission is saved on disk`, e.message);
      return reply(
        req,
        res,
        502,
        `Your message couldn't be emailed right now. Please email ${MAIL_TO} directly or DM @gilscustoms on Instagram.`
      );
    }

    console.log(`[contact] emailed submission ${id} from ${f.email}`);
    return reply(req, res, 200, "Thanks! We'll get back to you soon.");
  });
});

app.get('/healthz', (req, res) => res.type('text').send('ok'));

// Old Wix URLs.
app.get(['/home', '/services'], (req, res) => res.redirect(301, req.path === '/home' ? '/' : '/service'));
app.get('/contact', (req, res) => res.redirect(301, '/contact-us'));
app.get(['/category/shop', '/shop'], (req, res) => res.redirect(302, '/service'));

// ---------------------------------------------------------------------------
// Pages and caching
// ---------------------------------------------------------------------------

// Pages are read once at startup and their CSS/JS links get a content hash
// (?v=...), so those files can be cached for a year while a deploy (which
// restarts the service) still shows changes right away.
const VERSIONED_ASSETS = ['css/style.css', 'js/main.js'];
const assetHash = crypto.createHash('sha256');
for (const asset of VERSIONED_ASSETS) assetHash.update(fs.readFileSync(path.join(PUBLIC_DIR, asset)));
const ASSET_VERSION = assetHash.digest('hex').slice(0, 10);

const pages = new Map();
for (const file of fs.readdirSync(PUBLIC_DIR)) {
  if (!file.endsWith('.html')) continue;
  let html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
  for (const asset of VERSIONED_ASSETS) html = html.split(`/${asset}"`).join(`/${asset}?v=${ASSET_VERSION}"`);
  html = TURNSTILE_ENABLED
    ? html.split('__TURNSTILE_SITE_KEY__').join(TURNSTILE_SITE_KEY)
    : html.replace(/\s*<div class="cf-turnstile"[^>]*><\/div>/g, '');
  pages.set(file.slice(0, -'.html'.length), html);
}

// Browsers re-check pages on every visit (a cheap 304 when nothing changed);
// Cloudflare's edge may keep them for an hour when a Cache Rule allows it.
const PAGE_CACHE = 'public, max-age=0, s-maxage=3600, must-revalidate';
const YEAR = 'public, max-age=31536000, immutable';

function sendPage(res, name, status = 200) {
  res
    .status(status)
    .set('Cache-Control', status === 200 ? PAGE_CACHE : 'no-store')
    .type('html')
    .send(pages.get(name));
}

app.get(/^\/(.+)\.html$/, (req, res) => res.redirect(301, req.params[0] === 'index' ? '/' : `/${req.params[0]}`));
app.get('/', (req, res) => sendPage(res, 'index'));
app.get('/:page', (req, res, next) => {
  const name = req.params.page;
  if (name === 'index' || name === '404' || !pages.has(name)) return next();
  sendPage(res, name);
});

app.use(
  express.static(PUBLIC_DIR, {
    index: false,
    setHeaders(res, filePath) {
      if (/\.(css|js)$/.test(filePath)) {
        res.set('Cache-Control', res.req.query.v ? YEAR : 'public, max-age=3600');
      } else if (/\.woff2$/.test(filePath)) {
        res.set('Cache-Control', YEAR);
      } else if (/\.(jpg|jpeg|png|webp|avif|svg|ico)$/.test(filePath)) {
        res.set('Cache-Control', 'public, max-age=2592000');
      }
    },
  })
);

app.use((req, res) => sendPage(res, '404', 404));

if (require.main === module) {
  app.listen(PORT, () => console.log(`Gils Customs site running on http://localhost:${PORT}`));
}

module.exports = app;
