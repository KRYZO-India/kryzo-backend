'use strict';

/**
 * Central env config. Missing values produce startup WARNINGS (not crashes),
 * so `npm run dev` always boots and every endpoint explains what is unconfigured.
 */
require('dotenv').config();

function num(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const env = {
  port: num('PORT', 3001),
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',

  groqApiKey: process.env.GROQ_API_KEY || '',
  groqModel: process.env.GROQ_MODEL || 'whisper-large-v3-turbo',

  razorpayKeyId: process.env.RAZORPAY_KEY_ID || '',
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || '',
  razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
  razorpayPlanId: process.env.RAZORPAY_PLAN_ID || '',
  razorpayMode: (process.env.RAZORPAY_MODE || 'test').toLowerCase(),

  // ---- Two paid tiers (locked 2026-10-07): Starter ₹399 / Pro ₹799 ----
  // Free tier: 2 min/month (locked 2026-10-08) — taste only, Captik-style.
  freeMinutesMonthly: num('FREE_MINUTES_MONTHLY', 2),
  starterPlanName: process.env.STARTER_PLAN_NAME || 'starter',
  starterPriceInr: num('STARTER_PRICE_INR', 399),
  starterMinutesMonthly: num('STARTER_MINUTES_MONTHLY', 100),
  proPlanName: process.env.PRO_PLAN_NAME || 'pro',
  proPriceInr: num('PRO_PRICE_INR', 799),
  // Pro = "unlimited" (fair use). A huge finite number keeps JSON + math safe.
  proMinutesMonthly: num('PRO_MINUTES_MONTHLY', 100000),
  razorpayStarterPlanId: process.env.RAZORPAY_STARTER_PLAN_ID || '',
  razorpayProPlanId: process.env.RAZORPAY_PRO_PLAN_ID || '',
};

env.supabaseConfigured = Boolean(
  env.supabaseUrl && env.supabaseAnonKey && env.supabaseServiceRoleKey
);
env.groqConfigured = Boolean(env.groqApiKey);
env.razorpayConfigured = Boolean(
  env.razorpayKeyId && env.razorpayKeySecret && (env.razorpayStarterPlanId || env.razorpayProPlanId)
);

function printWarnings() {
  const missing = [];
  if (!env.supabaseConfigured)
    missing.push('SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY');
  if (!env.groqConfigured) missing.push('GROQ_API_KEY');
  if (!env.razorpayConfigured)
    missing.push('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_STARTER_PLAN_ID / RAZORPAY_PRO_PLAN_ID');
  if (!env.razorpayWebhookSecret)
    missing.push('RAZORPAY_WEBHOOK_SECRET (webhooks will be rejected)');
  if (missing.length) {
    console.warn('\n⚠️  KRYZO backend starting WITHOUT:');
    missing.forEach((m) => console.warn('   - ' + m));
    console.warn('   Endpoints that need them return 503 with a clear message.\n');
  } else {
    console.log('✅ All integrations configured.');
  }
}

module.exports = { env, printWarnings };
