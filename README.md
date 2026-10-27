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
- **Photos:** drop new images in `public/img/` and update the `src` in the HTML. Keep them under ~300 KB (resize to ~1200px wide).
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

## Image credits

- Logo, banner and workshop photos: Gils Customs (frames from the [@GilsCustoms](https://www.youtube.com/@GilsCustoms) YouTube channel).
- Car photos (`hero-car.jpg`, `headlights-glow.jpg`, `headlight-closeup.jpg`, `truck-taillight.jpg`): the free stock images already used on the previous Wix site. Replace them with photos of your own builds whenever you have them.
