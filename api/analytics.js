const { Redis } = require('@upstash/redis');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return res.status(200).json({ available: false, reason: 'KV not configured' });
  }

  try {
const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }

    const [patterns, feedbackSummary, feedbackIds, ...dailyCounts] = await Promise.all([
      kv.get('pmar:patterns'),
      kv.get('pmar:feedback_summary'),
      kv.lrange('pmar:feedback_ids', 0, 19),
      ...days.map(d => kv.hget('pmar:daily', d))
    ]);

    let recentFeedback = [];
    if (feedbackIds && feedbackIds.length > 0) {
      const entries = await Promise.all(fee
