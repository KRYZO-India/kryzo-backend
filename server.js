'use strict';

/**
 * KRYZO backend — Express server.
 *
 * Endpoints:
 *   GET  /                      → service info + integration status
 *   GET  /health                 → liveness probe
 *   POST /api/transcribe         → Groq transcription proxy (auth + quota)
 *   POST /api/billing/checkout   → create Razorpay subscription (auth)
 *   POST /api/billing/webhook    → Razorpay events (signature-verified, NO auth)
 *   GET  /api/billing/status     → plan + subscription + usage (auth)
 *   GET  /api/usage              → monthly usage (auth)
 *
 * IMPORTANT: the webhook needs the RAW request body for HMAC verification,
 * so its route gets express.raw() BEFORE the global express.json() parser.
 */
const express = require('express');
const cors = require('cors');
const { env, printWarnings } = require('./env');

const app = express();

// ---- CORS: only the known frontends ----
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl / server-to-server
      if (env.corsOrigins.length === 0 || env.corsOrigins.includes(origin)) {
        return cb(null, true);
      }
      return cb(new Error('CORS blocked for origin ' + origin));
    },
  })
);

// ---- Webhook raw body FIRST (signature verification needs exact bytes) ----
app.use('/api/billing/webhook', express.raw({ type: '*/*', limit: '1mb' }));

// ---- JSON for everything else ----
app.use(express.json({ limit: '1mb' }));

// ---- Routes ----
app.use('/api/transcribe', require('./transcribe'));
app.use('/api/billing', require('./billing'));
app.use('/api/usage', require('./usage'));

app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get('/', (req, res) =>
  res.json({
    service: 'kryzo-backend',
    version: '0.1.0',
    mode: process.env.DEV_NO_AUTH === '1' ? 'dev-no-auth' : 'normal',
    integrations: {
      supabase: env.supabaseConfigured,
      groq: env.groqConfigured,
      razorpay: env.razorpayConfigured,
      razorpayMode: env.razorpayMode,
    },
    plan: { name: env.planName, priceInr: env.planPriceInr },
    endpoints: [
      'POST /api/transcribe',
      'POST /api/billing/checkout',
      'POST /api/billing/webhook',
      'GET  /api/billing/status',
      'GET  /api/usage',
    ],
  })
);

// ---- 404 + error handler ----
app.use((req, res) => res.status(404).json({ error: 'not_found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[server] unhandled error:', err.message);
  res.status(500).json({ error: 'internal_error' });
});

app.listen(env.port, () => {
  console.log(`\n🚀 kryzo-backend listening on http://localhost:${env.port}`);
  printWarnings();
  if (process.env.DEV_NO_AUTH === '1') {
    console.warn('⚠️  DEV_NO_AUTH=1 — auth is BYPASSED. Never use in production.\n');
  }
});
