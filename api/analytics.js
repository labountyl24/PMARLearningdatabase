const { Redis } = require('@upstash/redis');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return res.status(200).json({ available: false, reason: 'Redis not configured' });
  }

  try {
    const kv = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });

    const days = [];
    for (var i = 13; i >= 0; i--) {
      var d = new Date();
      d.setDate(d.getDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }

    const results = await Promise.all([
      kv.get('pmar:patterns'),
      kv.get('pmar:feedback_summary'),
      kv.lrange('pmar:feedback_ids', 0, 19)
    ]);

    const patterns = results[0];
    const feedbackSummary = results[1];
    const feedbackIds = results[2];

    const dailyCounts = await Promise.all(
      days.map(function(day) { return kv.hget('pmar:daily', day); })
    );

    var recentFeedback = [];
    if (feedbackIds && feedbackIds.length > 0) {
      const entries = await Promise.all(
        feedbackIds.map(function(id) { return kv.get(id); })
      );
      recentFeedback = entries
        .filter(Boolean)
        .map(function(e) { return typeof e === 'string' ? JSON.parse(e) : e; })
        .slice(0, 10);
    }

    const dailyData = days.map(function(day, i) {
      return { day: day, count: parseInt(dailyCounts[i]) || 0 };
    });

    return res.status(200).json({
      available: true,
      patterns: patterns || {},
      dailyData: dailyData,
      feedbackSummary: feedbackSummary || {},
      recentFeedback: recentFeedback,
    });
  } catch (err) {
    return res.status(500).json({ available: false, reason: err.message });
  }
};
