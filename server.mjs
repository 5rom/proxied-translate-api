import 'dotenv/config';
import { createServer } from 'http';
import { translate } from 'google-translate-api-x';
import { ProxyAgent } from 'undici';

// --- Configuration from environment variables ---
const PORT = parseInt(process.env.PORT, 10) || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const MAX_TEXT_LENGTH = parseInt(process.env.MAX_TEXT_LENGTH, 10) || 5000;
const MAX_BATCH_SIZE = parseInt(process.env.MAX_BATCH_SIZE, 10) || 50;
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60_000;
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX, 10) || 60;
const LOG_LEVEL = process.env.LOG_LEVEL || 'info'; // 'debug' | 'info' | 'warn' | 'error'

// Proxy config — leave PROXY_URL empty to disable proxy entirely
const PROXY_URL = process.env.PROXY_URL || '';
const PROXY_PORT = process.env.PROXY_PORT || '';
const PROXY_USERNAME = process.env.PROXY_USERNAME || '';
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || '';
const PROXY_FALLBACK = process.env.PROXY_FALLBACK !== 'false'; // fallback to direct if proxy fails

// --- Logging ---
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLogLevel = LOG_LEVELS[LOG_LEVEL] ?? 1;

function log(level, ...args) {
  if ((LOG_LEVELS[level] ?? 1) >= currentLogLevel) {
    const ts = new Date().toISOString();
    console[level === 'debug' ? 'log' : level](`[${ts}] [${level.toUpperCase()}]`, ...args);
  }
}

// --- Proxy agent (created once, reused) ---
// Native fetch (Node 18+) requires undici ProxyAgent as dispatcher,
// not the legacy http.Agent used by https-proxy-agent.
function buildProxyAgent() {
  if (!PROXY_URL) return null;
  const auth = PROXY_USERNAME ? `${PROXY_USERNAME}:${PROXY_PASSWORD}@` : '';
  const url = `http://${auth}${PROXY_URL}:${PROXY_PORT || 443}`;
  log('info', `Proxy enabled → ${PROXY_URL}:${PROXY_PORT || 443}`);
  return new ProxyAgent(url);
}

const proxyAgent = buildProxyAgent();
const proxyEnabled = proxyAgent !== null;

// --- Simple in-memory rate limiter (per IP) ---
const rateLimitMap = new Map();

function isRateLimited(ip) {
  if (RATE_LIMIT_MAX <= 0) return false;
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry = { windowStart: now, count: 0 };
    rateLimitMap.set(ip, entry);
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

// Periodically clean up stale entries
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitMap.delete(ip);
    }
  }
}, RATE_LIMIT_WINDOW_MS);

// --- CORS ---
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// --- Helpers ---
function json(res, statusCode, data) {
  const headers = { ...corsHeaders(), 'Content-Type': 'application/json' };
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(data));
}

function readBody(req, maxBytes = 1_048_576) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function clientIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown'
  );
}

function summarizeText(text) {
  if (Array.isArray(text)) return `Array[${text.length}]`;
  if (typeof text === 'string') {
    return text.length > 40 ? text.slice(0, 40) + '…' : text;
  }
  return String(text);
}

// --- Translate logic ---
async function translateText(text, targetLang) {
  const opts = { to: targetLang, rejectOnPartialFail: false, forceBatch: false };
  if (proxyEnabled) {
    try {
      log('debug', 'Attempting translation via proxy');
      const proxyFetch = (url, init) => fetch(url, { ...init, dispatcher: proxyAgent });
      const result = await translate(text, { ...opts, requestFunction: proxyFetch });
      log('debug', 'Proxy translation succeeded');
      return result;
    } catch (err) {
      log('warn', `Proxy translation failed: ${err.message}`);
      if (!PROXY_FALLBACK) throw err;
      log('info', 'Falling back to direct connection');
    }
  }

  const result = await translate(text, opts);
  log('debug', 'Direct translation succeeded');
  return result;
}

// --- Validation ---
function validateTranslateInput(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { error: 'Invalid JSON in request body', status: 400 };
  }

  const { text, to } = parsed;

  if (!text) {
    return { error: '"text" field is required', status: 400 };
  }

  if (Array.isArray(text)) {
    if (text.length === 0) {
      return { error: '"text" array must not be empty', status: 400 };
    }
    if (text.length > MAX_BATCH_SIZE) {
      return { error: `Batch size exceeds limit of ${MAX_BATCH_SIZE}`, status: 400 };
    }
    const oversize = text.some((t) => typeof t === 'string' && t.length > MAX_TEXT_LENGTH);
    if (oversize) {
      return { error: `One or more texts exceed max length of ${MAX_TEXT_LENGTH}`, status: 400 };
    }
  } else if (typeof text === 'string') {
    if (text.length > MAX_TEXT_LENGTH) {
      return { error: `Text exceeds max length of ${MAX_TEXT_LENGTH}`, status: 400 };
    }
  } else {
    return { error: '"text" must be a string or an array of strings', status: 400 };
  }

  if (to && typeof to !== 'string') {
    return { error: '"to" must be a language code string (e.g. "en", "vi", "ja")', status: 400 };
  }

  return { text, to: to || 'en' };
}

// --- Request handler ---
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const ip = clientIp(req);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  // Rate limit check
  if (isRateLimited(ip)) {
    log('warn', `Rate limited: ${ip}`);
    json(res, 429, {
      error: 'Too many requests. Please try again later.',
      retryAfterMs: RATE_LIMIT_WINDOW_MS,
    });
    return;
  }

  // GET /
  if (req.method === 'GET' && url.pathname === '/') {
    json(res, 200, {
      name: 'Proxied Translate API',
      version: process.env.npm_package_version || '2.0.0',
      endpoints: {
        health: 'GET /health',
        translate: 'POST /translate',
        languages: 'GET /languages',
      },
    });
    return;
  }

  // GET /health
  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, {
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      proxy: proxyEnabled ? 'enabled' : 'disabled',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // GET /languages — common language codes reference
  if (req.method === 'GET' && url.pathname === '/languages') {
    json(res, 200, {
      note: 'Full list at https://cloud.google.com/translate/docs/languages',
      common: {
        en: 'English', vi: 'Vietnamese', zh: 'Chinese (Simplified)',
        ja: 'Japanese', ko: 'Korean', fr: 'French', de: 'German',
        es: 'Spanish', pt: 'Portuguese', ru: 'Russian', th: 'Thai',
        ar: 'Arabic', hi: 'Hindi', id: 'Indonesian',
      },
    });
    return;
  }

  // POST /translate
  if (req.method === 'POST' && url.pathname === '/translate') {
    try {
      const body = await readBody(req);
      const input = validateTranslateInput(body);

      if (input.error) {
        json(res, input.status, { error: input.error });
        return;
      }

      const { text, to } = input;
      log('info', `Translate [${ip}]: ${summarizeText(text)} → ${to}`);

      const result = await translateText(text, to);

      const translatedText = Array.isArray(result)
        ? result.map((r) => r.text)
        : result?.text;

      json(res, 200, { translatedText });
    } catch (err) {
      log('error', `Translation error: ${err.message}`);
      json(res, 500, { error: 'Translation failed: ' + err.message });
    }
    return;
  }

  // 404
  json(res, 404, { error: `Cannot ${req.method} ${url.pathname}` });
}

// --- Start server ---
const server = createServer(handleRequest);

server.listen(PORT, () => {
  log('info', `Proxied Translate API running on port ${PORT}`);
  log('info', `Proxy: ${proxyEnabled ? 'ENABLED' : 'DISABLED (direct connection)'}`);
  if (proxyEnabled && PROXY_FALLBACK) {
    log('info', 'Proxy fallback to direct connection: ENABLED');
  }
  log('info', `CORS origin: ${CORS_ORIGIN}`);
  log('info', `Rate limit: ${RATE_LIMIT_MAX} req / ${RATE_LIMIT_WINDOW_MS / 1000}s`);
});

// Graceful shutdown
function shutdown(signal) {
  log('info', `${signal} received, shutting down gracefully`);
  server.close(() => {
    log('info', 'Server closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
