'use strict';

/**
 * POST /api/transcribe — Groq transcription PROXY.
 *
 * Why a proxy: the Groq API key must live ONLY in server env vars. The current
 * app calls Groq straight from the browser, which exposes the key to anyone.
 * After this backend ships, the frontend sends audio HERE with its Supabase
 * JWT instead, and the key never leaves the server.
 *
 * Flow: multipart audio upload → requireAuth → checkQuota → forward to Groq →
 * record minutes used (only on success) → return Groq's verbose JSON (words +
 * timestamps) to the client. Client-side Hinglish dictionaries stay where
 * they are for now (see ARCHITECTURE.md).
 */
const express = require('express');
const multer = require('multer');
const { requireAuth } = require('./auth');
const { checkQuota, recordUsage } = require('./metering');
const { env } = require('./env');

const router = express.Router();

// In-memory upload, 25 MB cap (Groq's own upload limit).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

router.post('/', requireAuth, checkQuota, upload.single('audio'), async (req, res) => {
  if (!env.groqConfigured) {
    return res.status(503).json({
      error: 'groq_not_configured',
      message: 'GROQ_API_KEY is not set on this server.',
    });
  }
  if (!req.file) {
    return res.status(400).json({
      error: 'missing_audio',
      message: 'Send multipart form-data with field "audio" (the audio/video file).',
    });
  }

  try {
    const form = new FormData();
    const blob = new Blob([req.file.buffer], {
      type: req.file.mimetype || 'audio/mpeg',
    });
    form.append('file', blob, req.file.originalname || 'audio.mp3');
    form.append('model', env.groqModel);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    form.append('temperature', '0');

    const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.groqApiKey}` },
      body: form,
    });

    const data = await groqRes.json().catch(() => ({}));
    if (!groqRes.ok) {
      console.error('[transcribe] Groq error:', groqRes.status, JSON.stringify(data).slice(0, 500));
      return res.status(502).json({
        error: 'groq_failed',
        message: (data && data.error && data.error.message) || 'Transcription provider failed.',
      });
    }

    // Minutes for metering: Groq reports total duration in seconds.
    const seconds = Number(data.duration) || 0;
    await recordUsage(req.user.id, seconds / 60);

    return res.json({
      text: data.text,
      duration: data.duration,
      words: data.words || [],
      segments: data.segments || [],
      quota: req.quota
        ? { plan: req.quota.plan, minutesLeft: req.quota.minutesLeft }
        : undefined,
    });
  } catch (e) {
    console.error('[transcribe] proxy failed:', e.message);
    return res.status(500).json({ error: 'transcribe_failed' });
  }
});

module.exports = router;
