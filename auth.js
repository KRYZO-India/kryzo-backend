'use strict';

/**
 * requireAuth — verifies the Supabase JWT from `Authorization: Bearer <jwt>`.
 *
 * Flow: the frontend signs in with Supabase Auth (email OTP) using the ANON key,
 * receives a session JWT, and sends it on every backend call. We validate it
 * here with the service-role client and attach the user to req.user.
 *
 * Without Supabase configured this middleware fails CLOSED (401) — except the
 * dev bypass below, which only works when explicitly enabled.
 */
const { getSupabaseAdmin } = require('./supabase');
const { env } = require('./env');

async function requireAuth(req, res, next) {
  // Local dev bypass: set DEV_NO_AUTH=1 to test endpoints without Supabase.
  // NEVER enable in production.
  if (process.env.DEV_NO_AUTH === '1') {
    req.user = { id: 'dev-user-00000000-0000-0000-0000-000000000000', email: 'dev@kryzo.local' };
    return next();
  }

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'missing_token', message: 'Authorization: Bearer <token> required' });
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return res.status(503).json({
      error: 'auth_not_configured',
      message: 'Supabase is not configured on this server.',
    });
  }

  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data || !data.user) {
      return res.status(401).json({ error: 'invalid_token', message: 'Token invalid or expired' });
    }
    req.user = { id: data.user.id, email: data.user.email };
    return next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid_token', message: 'Token verification failed' });
  }
}

module.exports = { requireAuth };
