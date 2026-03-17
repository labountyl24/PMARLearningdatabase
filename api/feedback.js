const { createClient } = require('@vercel/kv');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { originalMessage, aiRouting, aiRole, aiReply, correctedRouting, correctedRole, feedbackNote, rating } = req.body;
  if (!originalMessage) return res.status(400).json({ error: 'No message provided.' });

  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return res.status(200).json({ ok: true, note: 'KV not configured, feedback not stored.' });
  }

  try {
    const kv = createClient({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });

    const id = `feedback:${Date.now()}`;
    const entry = {
      id,
      timestamp: new Date().toISOString(),
      originalMessage: originalMessage.substring(0, 300),
      aiRouting, aiRole,
      aiReply: aiReply ? aiReply.substring(0, 500) : '',
      correctedRouting: correctedRouting || null,
      correctedRole: correctedRole || null,
      feedbackNote: feedbackNote || '',
      rating,
    };

    await kv.set(id, JSON.stringify(entry));
    await kv.lpush('pmar:feedback_ids', id);
    await kv.ltrim('pmar:feedback_ids', 0, 199);
    await kv.incr('pmar:feedback_total');
    await kv.hincrby('pmar:feedback_ratings', rating, 1);

    if (correctedRouting && correctedRouting !== aiRouting) {
      const correctionKey = `${aiRouting}->${correctedRouting}`;
      await kv.hincrby('pmar:routing_corrections', correctionKey, 1);
    }

    const [total, ratings, corrections] = await Promise.all([
      kv.get('pmar:feedback_total'),
      kv.hgetall('pmar:feedback_ratings'),
      kv.hgetall('pmar:routing_corrections'),
    ]);

    await kv.set('pmar:feedback_summary', {
      total: parseInt(total) || 0,
      ratings: ratings || {},
      corrections: corrections || {},
      lastUpdated: Date.now(),
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
