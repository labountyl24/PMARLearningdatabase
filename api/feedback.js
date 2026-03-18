const { Redis } = require('@upstash/redis');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { aiRouting, aiRole, correctedRouting, correctedRole, feedbackNote, rating } = req.body;

  // NOTE: originalMessage and aiReply are intentionally NOT stored to avoid PHI retention

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return res.status(200).json({ ok: true, note: 'Redis not configured, feedback not stored.' });
  }

  try {
    const kv = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });

    const id = 'feedback:' + Date.now();
    const entry = {
      id: id,
      timestamp: new Date().toISOString(),
      // Raw message and reply intentionally omitted - PHI risk
      aiRouting: aiRouting,
      aiRole: aiRole,
      correctedRouting: correctedRouting || null,
      correctedRole: correctedRole || null,
      feedbackNote: feedbackNote || '',
      rating: rating,
    };

    await kv.set(id, JSON.stringify(entry));
    await kv.lpush('pmar:feedback_ids', id);
    await kv.ltrim('pmar:feedback_ids', 0, 199);
    await kv.incr('pmar:feedback_total');
    await kv.hincrby('pmar:feedback_ratings', rating, 1);

    if (correctedRouting && correctedRouting !== aiRouting) {
      const correctionKey = aiRouting + '->' + correctedRouting;
      await kv.hincrby('pmar:routing_corrections', correctionKey, 1);
    }

    const total = await kv.get('pmar:feedback_total');
    const ratings = await kv.hgetall('pmar:feedback_ratings');
    const corrections = await kv.hgetall('pmar:routing_corrections');

    await kv.set('pmar:feedback_summary', JSON.stringify({
      total: parseInt(total) || 0,
      ratings: ratings || {},
      corrections: corrections || {},
      lastUpdated: Date.now(),
    }));

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
