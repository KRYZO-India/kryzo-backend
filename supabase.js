'use strict';

/**
 * Supabase admin client (service_role). Server-side only.
 * Bypasses Row Level Security — never expose this client or its key to the browser.
 */
const { createClient } = require('@supabase/supabase-js');
const { env } = require('./env');

let admin = null;

function getSupabaseAdmin() {
  if (admin) return admin;
  if (!env.supabaseConfigured) return null;
  admin = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return admin;
}

module.exports = { getSupabaseAdmin };
