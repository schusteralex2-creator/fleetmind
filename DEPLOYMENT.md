# FleetMind — Cloudflare Deployment Guide

Everything you need to get FleetMind running on Cloudflare Pages + Workers.  
Estimated time: **30–45 minutes** (most of it is waiting for deploys).

---

## What You're Deploying

```
GitHub repo
  ├── construction-rag-chatbot.jsx   → Cloudflare Pages  (the app)
  └── proxy-worker.js                → Cloudflare Worker (the fetch proxy)
```

Both are free on Cloudflare's free tier at any realistic internal usage volume.

---

## Prerequisites

- A **Cloudflare account** (free): https://dash.cloudflare.com/sign-up
- A **GitHub account** (free): https://github.com
- **Node.js 18+** installed on your machine: https://nodejs.org
- An **Anthropic API key**: https://console.anthropic.com

---

## Step 1 — Set Up the GitHub Repo

1. Create a new repository on GitHub (can be private).
2. Create the following folder structure locally:

```
fleetmind/
  ├── proxy-worker.js          (provided)
  ├── wrangler.toml            (provided)
  ├── package.json             (create this — see below)
  └── src/
      └── App.jsx              (the chatbot file, renamed)
```

3. Create `package.json`:

```json
{
  "name": "fleetmind",
  "version": "1.0.0",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "mammoth": "^1.6.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.0.0",
    "vite": "^5.0.0"
  }
}
```

4. Create `vite.config.js`:

```js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
})
```

5. Create `index.html` in the root:

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>FleetMind</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

6. Create `src/main.jsx`:

```jsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'

ReactDOM.createRoot(document.getElementById('root')).render(<App />)
```

7. Push everything to GitHub:

```bash
git init
git add .
git commit -m "Initial FleetMind deploy"
git remote add origin https://github.com/YOUR_USERNAME/fleetmind.git
git push -u origin main
```

---

## Step 2 — Add Your Anthropic API Key as a Secret

The API key must not be hardcoded in the frontend (it would be visible to anyone).  
Instead, you'll inject it at build time via an environment variable.

In `src/App.jsx`, find all three instances of:

```js
headers: { "Content-Type": "application/json" },
```

And add the API key header:

```js
headers: {
  "Content-Type": "application/json",
  "x-api-key": import.meta.env.VITE_ANTHROPIC_API_KEY,
  "anthropic-version": "2023-06-01",
  "anthropic-dangerous-direct-browser-access": "true",
},
```

You'll set the actual key value in Cloudflare Pages settings in Step 3.

---

## Step 3 — Deploy the Frontend to Cloudflare Pages

1. Go to https://dash.cloudflare.com → **Workers & Pages** → **Create**
2. Choose **Pages** → **Connect to Git**
3. Select your `fleetmind` repo and click **Begin setup**
4. Configure the build:

| Setting | Value |
|---|---|
| Framework preset | None (or Vite) |
| Build command | `npm run build` |
| Build output directory | `dist` |

5. Under **Environment variables**, add:

| Variable | Value |
|---|---|
| `VITE_ANTHROPIC_API_KEY` | Your Anthropic API key (mark as **Secret**) |

6. Click **Save and Deploy**. 

Cloudflare will build and deploy your app. You'll get a URL like:  
`https://fleetmind-abc123.pages.dev`

> **Note:** Any future `git push` to `main` will automatically trigger a redeploy.

---

## Step 4 — Deploy the Proxy Worker

1. Install Wrangler (Cloudflare's CLI):

```bash
npm install -g wrangler
```

2. Log in to Cloudflare:

```bash
wrangler login
```

3. From your project root, deploy the Worker:

```bash
wrangler deploy
```

You'll see output like:
```
Deployed fleetmind-proxy to https://fleetmind-proxy.YOUR_SUBDOMAIN.workers.dev
```

4. Copy that Worker URL — you'll need it in the next step.

---

## Step 5 — Point the App at the Proxy

In `src/App.jsx`, find the `extractTextFromUrl` function and update the fetch call  
to route through your Worker instead of fetching directly:

```js
// Replace this:
const resp = await fetch(url);

// With this:
const proxyUrl = `https://fleetmind-proxy.YOUR_SUBDOMAIN.workers.dev/proxy?url=${encodeURIComponent(url)}`;
const resp = await fetch(proxyUrl);
```

Commit and push — Pages will auto-redeploy.

---

## Step 6 (Optional) — Custom Internal Domain

If you want techs to access it at e.g. `fleetmind.yourcompany.com`:

1. Your domain must be on Cloudflare DNS (free).
2. In **Pages** → your project → **Custom domains** → **Set up a custom domain**
3. Enter `fleetmind.yourcompany.com` and follow the prompts.
4. Update `wrangler.toml` — uncomment the `[[routes]]` section and fill in your domain.
5. Re-run `wrangler deploy`.

Done. DNS propagation takes 1–5 minutes.

---

## Step 7 — Add Manufacturer Domains to the Proxy Allowlist

If a URL import fails with "Domain not allowed", open `proxy-worker.js` and add  
the domain to the `ALLOWED_DOMAINS` array near the top:

```js
const ALLOWED_DOMAINS = [
  // ... existing entries ...
  "docs.yourequipmentsupplier.com",   // add your domain here
];
```

Then redeploy:

```bash
wrangler deploy
```

---

## Cost Summary

| Service | Free Tier | Paid |
|---|---|---|
| Cloudflare Pages | Unlimited requests, 500 builds/mo | Free |
| Cloudflare Workers | 100,000 req/day | $5/mo for 10M req |
| Cloudflare DNS | Unlimited | Free |
| **Total** | **$0/mo** | **$5/mo if you hit limits** |

---

## Troubleshooting

**Build fails on Pages**  
→ Check the build log in the Pages dashboard. Most common cause: missing environment variable or wrong build output directory (`dist`).

**API calls return 401 Unauthorized**  
→ Double-check the `VITE_ANTHROPIC_API_KEY` environment variable is set correctly in Pages settings and that you added the `x-api-key` header to all three fetch calls.

**URL import fails with "Domain not allowed"**  
→ Add the domain to `ALLOWED_DOMAINS` in `proxy-worker.js` and run `wrangler deploy`.

**URL import fails with "Fetch failed" or 502**  
→ The target site may block automated requests. Try downloading the PDF manually and uploading it directly instead.

**Manuals not persisting across sessions**  
→ The shared storage is tied to the Cloudflare artifact environment. If you've self-hosted outside of Claude's artifact system, you'll need to swap the storage layer for Cloudflare KV (happy to provide that code on request).

---

## Getting Help

- Cloudflare Pages docs: https://developers.cloudflare.com/pages
- Cloudflare Workers docs: https://developers.cloudflare.com/workers
- Wrangler CLI docs: https://developers.cloudflare.com/workers/wrangler
- Anthropic API docs: https://docs.anthropic.com
