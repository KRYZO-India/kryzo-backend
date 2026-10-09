'use strict';

/**
 * Auth proxy — lets the frontend do email-OTP login WITHOUT talking to
 * Supabase directly. The phone only reaches this backend (Render), and the
 * backend talks to Supabase server-to-server with the service_role key.
 *
 *   POST /api/auth/send-otp    { email }            → sends 6-digit OTP
 *   POST /api/auth/verify-otp  { email, token }     → verifies OTP, returns session
 *
 * The returned session contains access_token + refresh_token + user.
 * The frontend stores access_token and sends it as
 * `Authorization: Bearer <access_token>` on /api/transcribe etc.
 * The existing requireAuth middleware already validates those tokens.
 */
const express = require('express');
const { getSupabaseAdmin } = require('./supabase');

const router = express.Router();

function bad(res, code, msg, status = 400) {
  return res.status(status).json({ error: code, message: msg });
}

// POST /api/auth/send-otp (also accepts GET for networks that block POST)
async function handleSendOtp(req, res) {
  const email = ((req.body && req.body.email) || req.query.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return bad(res, 'invalid_email', 'Sahi email dalo');
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return bad(res, 'auth_not_configured', 'Server par auth configure nahi hai', 503);
  }

  try {
    const { error } = await supabase.auth.signInWithOtp({ email });
    if (error) {
      console.error('[auth-proxy] send-otp error:', error.message);
      return bad(res, 'otp_failed', error.message || 'OTP bhejne mein dikkat aayi');
    }
    return res.json({ ok: true, message: 'OTP bhej diya!' });
  } catch (e) {
    console.error('[auth-proxy] send-otp exception:', e.message);
    return bad(res, 'otp_failed', 'OTP bhejne mein dikkat aayi', 500);
  }
}
router.post('/send-otp', handleSendOtp);
router.get('/send-otp', handleSendOtp);

// POST /api/auth/verify-otp (also accepts GET for networks that block POST)
async function handleVerifyOtp(req, res) {
  const email = ((req.body && req.body.email) || req.query.email || '').trim().toLowerCase();
  const token = ((req.body && req.body.token) || req.query.token || '').trim();
  if (!email || !token) {
    return bad(res, 'missing_fields', 'Email aur OTP dono chahiye');
  }
  if (!/^\d{6}$/.test(token)) {
    return bad(res, 'invalid_otp', '6-digit OTP dalo');
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return bad(res, 'auth_not_configured', 'Server par auth configure nahi hai', 503);
  }

  try {
    const { data, error } = await supabase.auth.verifyOtp({
      email,
      token,
      type: 'email',
    });
    if (error || !data || !data.session) {
      console.error('[auth-proxy] verify-otp error:', error && error.message);
      return res.status(401).json({
        error: 'invalid_otp',
        message: (error && error.message) || 'OTP galat ya expire ho gaya',
      });
    }
    const s = data.session;
    return res.json({
      ok: true,
      access_token: s.access_token,
      refresh_token: s.refresh_token,
      expires_in: s.expires_in,
      user: { id: s.user.id, email: s.user.email },
    });
  } catch (e) {
    console.error('[auth-proxy] verify-otp exception:', e.message);
    return bad(res, 'verify_failed', 'Verify karne mein dikkat aayi', 500);
  }
}
router.post('/verify-otp', handleVerifyOtp);
router.get('/verify-otp', handleVerifyOtp);

module.exports = router;
