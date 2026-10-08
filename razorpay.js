'use strict';

/**
 * Razorpay SDK — lazily initialised. Returns null when keys are missing so
 * billing endpoints can answer 503 with a helpful message instead of crashing.
 */
const Razorpay = require('razorpay');
const { env } = require('./env');

let instance = null;

function getRazorpay() {
  if (instance) return instance;
  if (!env.razorpayKeyId || !env.razorpayKeySecret) return null;
  instance = new Razorpay({
    key_id: env.razorpayKeyId,
    key_secret: env.razorpayKeySecret,
  });
  return instance;
}

function isLive() {
  return env.razorpayMode === 'live';
}

module.exports = { getRazorpay, isLive };
