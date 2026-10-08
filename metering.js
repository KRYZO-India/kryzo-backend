'use strict';

/**
 * Usage metering — per-user transcription minutes per calendar month.
 *
 * checkQuota: loads the caller's plan from `profiles` and this month's usage
 * from `usage_minutes`. Attaches req.quota = { plan, minutesUsed, minutesLimit,
 * minutesLeft }. Responds 402 when the monthly allowance is exhausted.
 *
 * recordUsage(userId, minutes): upserts the month row (called AFTER a
 * successful transcription — never charge quota for failed jobs).
 */
const { getSupabaseAdmin } = require('./supabase');
const { env } = require('./env');

function monthKey(d = new Date()) {
  return d.toISOString().slice(0, 7); // "2026-10"
}

function limitForPlan(plan) {
  // Three tiers (locked 2026-10-07): free 30 min, starter (₹399) 100 min,
  // pro (₹799) effectively unlimited (huge finite cap, fair-use wording in app).
  if (plan === env.proPlanName) return env.proMinutesMonthly;
  if (plan === env.starterPlanName) return env.starterMinutesMonthly;
  return env.freeMinutesMonthly;
}

async function getProfile(supabase, userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('plan, is_active')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  // No row yet (user never touched billing) → free plan defaults.
  return data || { plan: 'free', is_active: false };
}

async function getMonthUsage(supabase, userId) {
  const { data, error } = await supabase
    .from('usage_minutes')
    .select('minutes_used')
    .eq('user_id', userId)
    .eq('month', monthKey())
    .maybeSingle();
  if (error) throw error;
  return data ? Number(data.minutes_used) : 0;
}

async function checkQuota(req, res, next) {
  // Local dev bypass (see auth.js). Unlimited quota for endpoint testing.
  if (process.env.DEV_NO_AUTH === '1') {
    req.quota = {
      plan: env.planName,
      minutesUsed: 0,
      minutesLimit: Number.POSITIVE_INFINITY,
      minutesLeft: Number.POSITIVE_INFINITY,
      devBypass: true,
    };
    return next();
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return res.status(503).json({
      error: 'metering_not_configured',
      message: 'Supabase is not configured on this server.',
    });
  }

  try {
    const profile = await getProfile(supabase, req.user.id);
    const plan = profile.is_active ? profile.plan : 'free';
    const minutesUsed = await getMonthUsage(supabase, req.user.id);
    const minutesLimit = limitForPlan(plan);

    req.quota = {
      plan,
      minutesUsed,
      minutesLimit,
      minutesLeft: Math.max(0, minutesLimit - minutesUsed),
    };

    if (minutesUsed >= minutesLimit) {
      return res.status(402).json({
        error: 'quota_exceeded',
        message: `Monthly transcription allowance exhausted (${minutesLimit} min on the ${plan} plan).`,
        quota: req.quota,
      });
    }
    return next();
  } catch (e) {
    console.error('[metering] quota check failed:', e.message);
    return res.status(500).json({ error: 'quota_check_failed' });
  }
}

/** Add `minutes` (rounded UP to whole minutes) to the caller's current month row. */
async function recordUsage(userId, minutes) {
  const supabase = getSupabaseAdmin();
  if (!supabase || process.env.DEV_NO_AUTH === '1') return;
  const whole = Math.max(1, Math.ceil(minutes));
  const mk = monthKey();
  // Upsert: insert or add to existing row.
  const { error } = await supabase.rpc('add_usage_minutes', {
    p_user_id: userId,
    p_month: mk,
    p_minutes: whole,
  });
  if (error) {
    // Fallback if the RPC is missing (schema.sql defines it — this is a safety net).
    console.error('[metering] rpc add_usage_minutes failed, trying manual upsert:', error.message);
    const { data } = await supabase
      .from('usage_minutes')
      .select('minutes_used')
      .eq('user_id', userId)
      .eq('month', mk)
      .maybeSingle();
    const next = (data ? Number(data.minutes_used) : 0) + whole;
    await supabase.from('usage_minutes').upsert(
      { user_id: userId, month: mk, minutes_used: next },
      { onConflict: 'user_id,month' }
    );
  }
}

module.exports = { checkQuota, recordUsage, getProfile, getMonthUsage, limitForPlan, monthKey };
