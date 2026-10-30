# Gils Customs website

Self-hosted replacement for the Wix site at [gilscustoms.com](https://www.gilscustoms.com).

- **Pages:** Home, Services (`/service`), FAQ (`/faq`), Contact (`/contact-us`). The URLs match the old Wix site so existing links keep working.
- **Contact forms** on the home page and contact page. Each submission is **emailed to you** (with any photos attached and Reply-To set to the customer) and also **saved to `data/submissions.jsonl`**, so nothing is lost if email ever fails.
- Spam protection: hidden honeypot field, minimum fill time and a per-IP rate limit. No CAPTCHA.
- Plain HTML/CSS/JS in `public/`. No build step. A tiny Node server (`server.js`) serves the pages and handles the form.

## Project layout

```
public/            The website itself
  index.html       Home page
  service.html     Services
  faq.html         FAQ (categories + search)
  contact-us.html  Contact form with photo upload
  thanks.html      Shown after a form is sent without JavaScript
  404.html
  css/style.css    All styling (colors are variables at the top)
  js/main.js       Mobile menu, form sending, FAQ tabs/search
  img/             Logo, banner, photos
server.js          Serves public/ and handles POST /api/contact
test/              Automated tests (npm test)
Dockerfile, docker-compose.yml, Caddyfile   Self-hosting setup
```

## Run it locally

Needs Node.js 20 or newer.

```bash
npm install
cp .env.example .env    # optional for local testing
npm run dev             # http://localhost:3000
npm test
```

Without SMTP settings, form messages are saved to `data/submissions.jsonl` and printed in the console instead of emailed.

## Editing content

- **Text:** edit the HTML files in `public/` directly. The header and footer are repeated in each page, so a nav or footer change needs to be made in all six HTML files.
- **FAQ:** each question is a `<details class="faq-item">` block inside its category in `public/faq.html`. Copy one to add a question. The search picks it up automatically.
- **Photos:** drop new images in `public/img/` and update the `src` in the HTML. Use WebP and size them to about twice how wide they're shown, for example:

  ```bash
  ffmpeg -i photo.jpg -vf "scale=1200:-2" -c:v libwebp -quality 78 public/img/photo.webp
  ```
- **Colors:** change the variables at the top of `public/css/style.css` (`--accent` is the cyan glow color).
- **Stats on the home page** (5+ years, 25+ clients, 100+ lights): search for `class="stats"` in `public/index.html`.

## Setting up email (SMTP)

Your domain's email (`david@gilscustoms.com`) is on **Google Workspace**, so the easiest option is sending through Gmail with an app password:

1. Turn on 2-Step Verification for the Google account.
2. Go to <https://myaccount.google.com/apppasswords> and create an app password (name it "Website").
3. In `.env`:

   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_SECURE=false
   SMTP_USER=david@gilscustoms.com
   SMTP_PASS=the-16-character-app-password
   MAIL_FROM=david@gilscustoms.com
   MAIL_TO=david@gilscustoms.com
   ```

Any other SMTP provider works too (Zoho, Brevo's free tier, Fastmail, etc.): just put their host/port/user/password in `.env`.

Set `AUTO_REPLY=true` to send customers a short "thanks, I got your message" email.

## Hosting

Pick one. All of them are far cheaper than Wix.

### Option A: Small VPS with Docker (about $4-6/month, recommended)

Any small Linux server works (Hetzner, DigitalOcean, Linode, Vultr, etc.). 1 vCPU / 1 GB RAM is plenty.

```bash
# On the server (Ubuntu/Debian):
curl -fsSL https://get.docker.com | sh
git clone https://github.com/gillygils/GilsCustoms.git
cd GilsCustoms
cp .env.example .env && nano .env      # fill in SITE_DOMAIN and SMTP settings
docker compose up -d --build
```

Caddy automatically gets a free HTTPS certificate once your domain points at the server (see "Moving the domain off Wix" below) and redirects `www.` to the bare domain.

To update after changing the site:

```bash
git pull && docker compose up -d --build
```

### Option B: A computer at home + Cloudflare Tunnel (free)

Works on a Raspberry Pi, old laptop or home server, with no port forwarding.

1. Move your domain's DNS to Cloudflare (free plan).
2. Run the site: either `npm ci --omit=dev && npm start` (use `pm2` or a systemd service to keep it running) or with Docker by uncommenting the `ports` section for `web` in `docker-compose.yml` and running only `docker compose up -d --build web`.
3. In Cloudflare Zero Trust, create a Tunnel and point `gilscustoms.com` at `http://localhost:3000`. Cloudflare handles HTTPS.

### Option B2: Proxmox LXC (no Docker)

Run Node directly in a Debian/Ubuntu container as a system service, then publish it with a Cloudflare Tunnel (Option B) or a port forward + reverse proxy.

```bash
apt update && apt install -y curl git ca-certificates
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

useradd --system --home /opt/gilscustoms --shell /usr/sbin/nologin gilscustoms
git clone <repo-url> /opt/gilscustoms
cd /opt/gilscustoms
npm ci --omit=dev
cp .env.example .env && nano .env          # SMTP settings
mkdir -p data && chown -R gilscustoms:gilscustoms data
chown root:gilscustoms .env && chmod 640 .env

cp deploy/gilscustoms.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now gilscustoms
curl http://localhost:3000/healthz         # prints "ok"
```

Logs: `journalctl -u gilscustoms -f`. Update: `cd /opt/gilscustoms && git pull && npm ci --omit=dev && systemctl restart gilscustoms`, then purge the Cloudflare cache (see below).

### Option C: Without Docker on any server

```bash
npm ci --omit=dev
PORT=3000 node server.js
```

Put it behind any reverse proxy (Caddy, nginx) for HTTPS. Form data and uploaded photos are stored in `./data` (or `DATA_DIR`).

## Moving the domain off Wix

Right now Wix runs your DNS (`ns14/ns15.wixdns.net`) and your email MX records point to Google Workspace. **Don't lose those MX records or your email will stop working.**

1. **Before cancelling Wix**, open Wix → Domains → your domain → Manage DNS records and screenshot/copy *everything*, especially the `MX` records and any `TXT` records (SPF `v=spf1 ...`, `google-site-verification`, DKIM `google._domainkey`).
2. If the domain was **bought through Wix**, transfer it to another registrar (Cloudflare Registrar, Porkbun, Namecheap). If it's registered elsewhere, just change its nameservers.
3. At the new DNS provider, re-create the MX and TXT records exactly as they were, then add:
   - `A` record `@` → your server's IP (Option A), or the Cloudflare Tunnel route (Option B)
   - `CNAME` record `www` → `gilscustoms.com`
4. If Google Workspace is billed **through Wix**, check that it stays active (or move billing to Google directly) before cancelling the Wix plan.
5. Once the new site loads at your domain, cancel the Wix premium plan.

## Backups

Everything worth backing up is in `data/` (form submissions and uploaded photos). The site itself lives in git.

## Spam protection (Cloudflare Turnstile)

The contact forms use a hidden honeypot field, a minimum fill time and a per-visitor rate limit. To stop bots that post to the form directly, turn on Cloudflare Turnstile (free):

1. Cloudflare dashboard → **Turnstile** (in the account sidebar, not inside the domain) → **Add widget**.
2. **Widget name:** Gils Customs contact form. **Hostnames:** `gilscustoms.com` and `www.gilscustoms.com`. **Widget mode:** Managed.
3. Copy the **Site Key** and **Secret Key** into `.env`:

   ```
   TURNSTILE_SITE_KEY=0x4AAAA...
   TURNSTILE_SECRET_KEY=0x4AAAA...
   ```

4. `systemctl restart gilscustoms`, then **Purge Everything** in Cloudflare so cached pages pick up the check box.

Most visitors never see a puzzle; Turnstile shows a small "Verifying… ✓" box above the Send button. Every submission is checked with Cloudflare on the server, so a bot posting to `/api/contact` without a valid pass gets rejected and is never emailed or saved. Rejections show up in `journalctl -u gilscustoms` as "failed the spam check". The Turnstile script only loads when a visitor scrolls near a form, so it doesn't slow down the page.

## Speed and caching

The server already sends the right caching headers:

- **CSS and JS** links get an automatic version tag (`?v=...`) when the server starts, so browsers and Cloudflare keep them for a year and still pick up changes after every deploy.
- **Fonts** are self-hosted in `public/fonts/` and cached for a year; **images** for 30 days.
- **Pages** tell Cloudflare it may keep them for an hour (`s-maxage=3600`); browsers re-check them every visit.

When the site runs behind Cloudflare, add one **Cache Rule** so Cloudflare serves pages from its edge instead of going through the tunnel to your server on every visit (this fixes "Reduce initial server response time" and "Document request latency" in Cloudflare's speed test):

1. Cloudflare dashboard → your domain → **Caching → Cache Rules → Create rule**.
2. **Custom filter expression:** Hostname *equals* `gilscustoms.com` **and** URI Path *does not start with* `/api/`.
3. **Cache eligibility:** Eligible for cache. **Edge TTL:** Use cache-control header if present.
4. Deploy.

Because pages are cached at Cloudflare for up to an hour, after updating the site go to **Caching → Configuration → Purge Everything** so visitors see the change right away.

Leave **Rocket Loader** off: it rewrites how scripts load and can break the intro animation and contact forms.

## Credits

- Logo, banner and workshop photos: Gils Customs (frames from the [@GilsCustoms](https://www.youtube.com/@GilsCustoms) YouTube channel).
- Car photos (`hero-car.webp`, `headlights-glow.webp`, `headlight-closeup.webp`, `truck-taillight.webp`): the free stock images already used on the previous Wix site. Replace them with photos of your own builds whenever you have them.
- Fonts: [Inter](https://fonts.google.com/specimen/Inter) and [Sora](https://fonts.google.com/specimen/Sora), both under the SIL Open Font License.
