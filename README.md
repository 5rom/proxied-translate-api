---
title: Proxied Translate API
description: Self-hosted Google Translate API with optional proxy support
tags:
  - nodejs
  - translation
  - api
  - proxy
  - google-translate
---

# Proxied Translate API

A lightweight, self-hosted Google Translate API with **optional proxy support**, rate limiting, and batch translation. Zero dependencies beyond Node.js — no database, no Redis, no external services required.

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template/ZweBXA)

## Why?

Google Translate doesn't offer a free API. This project wraps the unofficial `google-translate-api-x` library into a simple REST API you can self-host. If Google rate-limits your server's IP, you can optionally route requests through a proxy.

## Quick Start

### 1-Click Deploy (Railway)

Click the **Deploy on Railway** button above. Configure environment variables in the Railway dashboard (all are optional — it works out of the box with defaults).

### Manual Deploy

```bash
git clone https://github.com/YOUR_USERNAME/proxied-translate-api.git
cd proxied-translate-api
npm install
npm start
```

The server starts on port `3000` by default. Override with the `PORT` environment variable.

### Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY server.mjs ./
EXPOSE 3000
CMD ["node", "server.mjs"]
```

```bash
docker build -t translate-api .
docker run -p 3000:3000 translate-api
```

## API Endpoints

### `GET /`

Service info and available endpoints.

### `GET /health`

Health check (used by Railway for automatic restarts).

```json
{
  "status": "ok",
  "uptime": 3600,
  "proxy": "disabled",
  "timestamp": "2026-03-28T12:00:00.000Z"
}
```

### `GET /languages`

Common language codes reference.

### `POST /translate`

Translate text to a target language.

**Single text:**

```bash
curl -X POST https://your-app.up.railway.app/translate \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world", "to": "vi"}'
```

```json
{ "translatedText": "Xin chào thế giới" }
```

**Batch translation (array):**

```bash
curl -X POST https://your-app.up.railway.app/translate \
  -H "Content-Type: application/json" \
  -d '{"text": ["Hello", "Goodbye"], "to": "ja"}'
```

```json
{ "translatedText": ["こんにちは", "さようなら"] }
```

**Parameters:**

| Field  | Type               | Required | Default | Description                    |
| ------ | ------------------ | -------- | ------- | ------------------------------ |
| `text` | `string \| string[]` | Yes      | —       | Text(s) to translate           |
| `to`   | `string`           | No       | `"en"`  | Target language code           |

## Configuration

All configuration is via **environment variables**. See [`.env.example`](.env.example) for the full list.

### Core Settings

| Variable             | Default  | Description                                  |
| -------------------- | -------- | -------------------------------------------- |
| `PORT`               | `3000`   | Server port                                  |
| `CORS_ORIGIN`        | `*`      | Allowed CORS origin (`*` = all)              |
| `LOG_LEVEL`          | `info`   | Logging level: `debug`, `info`, `warn`, `error` |
| `MAX_TEXT_LENGTH`    | `5000`   | Max characters per text                      |
| `MAX_BATCH_SIZE`     | `50`     | Max items in a batch request                 |
| `RATE_LIMIT_MAX`     | `60`     | Max requests per IP per window (0 = off)     |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window in milliseconds           |

### Proxy Settings (Optional)

The proxy is **disabled by default**. Leave `PROXY_URL` empty to use direct connections.

| Variable         | Default | Description                                     |
| ---------------- | ------- | ----------------------------------------------- |
| `PROXY_URL`      | _(empty)_ | Proxy hostname (e.g. `abc.example-proxy.co`)     |
| `PROXY_PORT`     | _(empty)_ | Proxy port (e.g. `123456`)                     |
| `PROXY_USERNAME` | _(empty)_ | Proxy authentication username                 |
| `PROXY_PASSWORD` | _(empty)_ | Proxy authentication password                 |
| `PROXY_FALLBACK` | `true`    | Fall back to direct if proxy fails            |

**How proxy logic works:**

```
PROXY_URL is empty?
  → YES: Always use direct connection (no proxy overhead)
  → NO:  Try proxy first
           → Success: Return result
           → Fail + PROXY_FALLBACK=true: Retry via direct connection
           → Fail + PROXY_FALLBACK=false: Return error
```

### When do you need a proxy?

- **You DON'T need a proxy** if your server is on a residential IP or a cloud provider that isn't heavily rate-limited by Google.
- **You DO need a proxy** if Google starts returning 429 errors or blocking your server IP due to high request volume. Residential proxy providers like BrightData, Oxylabs, or SmartProxy work well.

## Deploy Anywhere

| Platform     | Steps                                                              |
| ------------ | ------------------------------------------------------------------ |
| **Railway**  | Click deploy button → set env vars in dashboard                    |
| **Render**   | Connect repo → set start command `node server.mjs` → add env vars |
| **Fly.io**   | `fly launch` → `fly secrets set PROXY_URL=...` → `fly deploy`     |
| **Heroku**   | `heroku create` → `git push heroku main`                          |
| **VPS**      | Clone repo → `npm install` → use PM2 or systemd to run            |
| **Docker**   | Build image → `docker run -p 3000:3000 -e PORT=3000 translate-api` |

## Usage Examples

### JavaScript / Fetch

```javascript
const res = await fetch('https://your-app.up.railway.app/translate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: 'Hello world', to: 'vi' }),
});
const { translatedText } = await res.json();
console.log(translatedText); // "Xin chào thế giới"
```

### Python

```python
import requests

r = requests.post('https://your-app.up.railway.app/translate', json={
    'text': 'Hello world',
    'to': 'vi'
})
print(r.json()['translatedText'])  # "Xin chào thế giới"
```

### cURL

```bash
curl -X POST https://your-app.up.railway.app/translate \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world", "to": "vi"}'
```

## Error Responses

| Code  | Meaning                                                     |
| ----- | ----------------------------------------------------------- |
| `400` | Invalid request (missing text, bad JSON, text too long)     |
| `404` | Unknown endpoint                                            |
| `429` | Rate limited — retry after the window resets                |
| `500` | Translation failed (Google API error or proxy/network issue)|

All errors return JSON:

```json
{ "error": "Description of what went wrong" }
```

## License

MIT
