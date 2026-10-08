'use strict';

/**
 * GET /api/usage — current month's transcription usage for the signed-in user.
 */
const express = require('express');
const { requireAuth } = require('./auth');
const { getSupabaseAdmin } = require('./supabase');
const { getProfile, getMonthUsage, limitForPlan, monthKey } = require('./metering');
const { env } = require('./env');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  if (process.env.DEV_NO_AUTH === '1') {
    return res.json({ month: monthKey(), plan: env.planName, minutesUsed: 0, minutesLimit: null, devBypass: true });
  }
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return res.status(503).json({ error: 'metering_not_configured' });
  }
  try {
    const profile = await getProfile(supabase, req.user.id);
    const plan = profile.is_active ? profile.plan : 'free';
    const minutesUsed = await getMonthUsage(supabase, req.user.id);
    const minutesLimit = limitForPlan(plan);
    return res.json({
      month: monthKey(),
      plan,
      minutesUsed,
      minutesLimit,
      minutesLeft: Math.max(0, minutesLimit - minutesUsed),
    });
  } catch (e) {
    console.error('[usage] failed:', e.message);
    return res.status(500).json({ error: 'usage_failed' });
  }
});

module.exports = router;
