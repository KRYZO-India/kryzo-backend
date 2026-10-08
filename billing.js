'use strict';

/**
 * Billing — Razorpay subscriptions.
 *
 *   POST /api/billing/checkout  (auth) → creates a Razorpay subscription for the
 *                                        chosen tier (starter ₹399 / pro ₹799),
 *                                        returns { subscription_id }
 *                                        for Razorpay Checkout on the frontend.
 *   POST /api/billing/webhook         → Razorpay event receiver. Verifies the
 *                                        HMAC signature with RAZORPAY_WEBHOOK_SECRET,
 *                                        then activates / deactivates the user.
 *                                        NOTE: mounted with express.raw() in
 *                                        server.js — signature check needs the
 *                                        exact raw body.
 *   GET  /api/billing/status    (auth) → current plan, subscription state, usage.
 *
 * Money flow: one plan per tier is created ONCE in the Razorpay dashboard
 * (Starter ₹399/month, Pro ₹799/month); their IDs go in
 * RAZORPAY_STARTER_PLAN_ID / RAZORPAY_PRO_PLAN_ID. total_count=12 = one year
 * of monthly cycles.
 */
const express = require('express');
const Razorpay = require('razorpay');
const { requireAuth } = require('./auth');
const { getSupabaseAdmin } = require('./supabase');
const { getRazorpay, isLive } = require('./razorpay');
const { getProfile, getMonthUsage, limitForPlan } = require('./metering');
const { env } = require('./env');

const router = express.Router();

function razorpayOr503(res) {
  const rzp = getRazorpay();
  if (!rzp) {
    res.status(503).json({
      error: 'razorpay_not_configured',
      message:
        'RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_PLAN_ID are not set. Add them to .env (test keys first).',
    });
    return null;
  }
  return rzp;
}

// ---- Create a subscription (frontend opens Razorpay Checkout with the id) ----
router.post('/checkout', requireAuth, async (req, res) => {
  const rzp = razorpayOr503(res);
  if (!rzp) return;

  // Frontend sends { plan: 'starter' | 'pro' }. Default: starter.
  const plan = req.body && req.body.plan === env.proPlanName ? env.proPlanName : env.starterPlanName;
  const razorpayPlanId = plan === env.proPlanName ? env.razorpayProPlanId : env.razorpayStarterPlanId;
  const amountInr = plan === env.proPlanName ? env.proPriceInr : env.starterPriceInr;

  if (!razorpayPlanId) {
    return res.status(503).json({
      error: 'plan_not_configured',
      message: `Razorpay plan ID for "${plan}" is not set (RAZORPAY_${plan === env.proPlanName ? 'PRO' : 'STARTER'}_PLAN_ID).`,
    });
  }

  try {
    const subscription = await rzp.subscriptions.create({
      plan_id: razorpayPlanId,
      customer_notify: 1,
      quantity: 1,
      total_count: 12, // 12 monthly billing cycles
      notes: { user_id: req.user.id, email: req.user.email || '', plan },
    });
    return res.json({
      subscription_id: subscription.id,
      key_id: env.razorpayKeyId, // public key — safe to expose
      plan,
      amount_inr: amountInr,
      mode: env.razorpayMode,
      live: isLive(),
    });
  } catch (e) {
    console.error('[billing] subscription create failed:', e.message || e);
    return res.status(502).json({ error: 'razorpay_failed', message: 'Could not create subscription.' });
  }
});

// ---- Webhook: the source of truth for who is paid ----
router.post('/webhook', async (req, res) => {
  // Always ACK fast; Razorpay retries on non-2xx.
  try {
    const signature = req.headers['x-razorpay-signature'];
    if (!env.razorpayWebhookSecret || !signature) {
      console.warn('[billing] webhook without secret/signature — rejected');
      return res.status(400).json({ error: 'missing_signature' });
    }

    const rawBody = req.body.toString('utf8');
    const valid = Razorpay.validateWebhookSignature(rawBody, signature, env.razorpayWebhookSecret);
    if (!valid) {
      console.warn('[billing] webhook signature mismatch — rejected');
      return res.status(400).json({ error: 'bad_signature' });
    }

    const event = JSON.parse(rawBody);
    await handleEvent(event);
    return res.json({ ok: true });
  } catch (e) {
    console.error('[billing] webhook handler failed:', e.message);
    // Still 200 so Razorpay doesn't hammer us; the failure is logged.
    return res.json({ ok: false });
  }
});

async function handleEvent(event) {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    console.warn('[billing] webhook received but Supabase not configured — event dropped:', event.event);
    return;
  }

  const type = event.event;
  const sub = event.payload && event.payload.subscription && event.payload.subscription.entity;

  switch (type) {
    case 'subscription.activated':
    case 'subscription.charged': {
      if (!sub) break;
      const userId = (sub.notes && sub.notes.user_id) || null;
      if (!userId) {
        console.warn('[billing] subscription event without user_id note:', sub.id);
        break;
      }
      // Plan comes from the checkout notes ('starter' | 'pro').
      const paidPlan = (sub.notes && (sub.notes.plan === env.proPlanName ? env.proPlanName : env.starterPlanName)) || env.starterPlanName;
      await supabase.from('subscriptions').upsert(
        {
          user_id: userId,
          razorpay_subscription_id: sub.id,
          razorpay_customer_id: sub.customer_id || null,
          plan: paidPlan,
          status: sub.status, // 'active'
          current_period_start: sub.current_start ? new Date(sub.current_start * 1000).toISOString() : null,
          current_period_end: sub.current_end ? new Date(sub.current_end * 1000).toISOString() : null,
        },
        { onConflict: 'razorpay_subscription_id' }
      );
      await supabase.from('profiles').upsert(
        { id: userId, plan: paidPlan, is_active: true },
        { onConflict: 'id' }
      );
      console.log(`[billing] activated ${paidPlan} for user ${userId} (${sub.id})`);
      break;
    }

    case 'subscription.cancelled':
    case 'subscription.completed':
    case 'subscription.halted': {
      if (!sub) break;
      const userId = (sub.notes && sub.notes.user_id) || null;
      await supabase
        .from('subscriptions')
        .update({ status: sub.status || type.split('.')[1] })
        .eq('razorpay_subscription_id', sub.id);
      if (userId) {
        await supabase.from('profiles').update({ is_active: false }).eq('id', userId);
        console.log(`[billing] deactivated paid plan for user ${userId} (${sub.id})`);
      }
      break;
    }

    case 'payment.failed':
      console.log('[billing] payment.failed — no state change');
      break;

    default:
      console.log('[billing] unhandled event:', type);
  }
}

// ---- Current billing state for the signed-in user ----
router.get('/status', requireAuth, async (req, res) => {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return res.json({
      plan: 'free',
      isActive: false,
      subscription: null,
      usage: { minutesUsed: 0, minutesLimit: env.freeMinutesMonthly },
      billingConfigured: false,
    });
  }
  try {
    const profile = await getProfile(supabase, req.user.id);
    const plan = profile.is_active ? profile.plan : 'free';
    const { data: sub } = await supabase
      .from('subscriptions')
      .select('razorpay_subscription_id,status,current_period_end')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const minutesUsed = await getMonthUsage(supabase, req.user.id);
    return res.json({
      plan,
      isActive: profile.is_active,
      subscription: sub || null,
      usage: { minutesUsed, minutesLimit: limitForPlan(plan) },
      billingConfigured: Boolean(getRazorpay()),
      tiers: {
        starter: { name: env.starterPlanName, priceInr: env.starterPriceInr, minutesMonthly: env.starterMinutesMonthly },
        pro: { name: env.proPlanName, priceInr: env.proPriceInr, minutesMonthly: env.proMinutesMonthly },
      },
    });
  } catch (e) {
    console.error('[billing] status failed:', e.message);
    return res.status(500).json({ error: 'status_failed' });
  }
});

module.exports = router;
