const { createClient } = require('@vercel/kv');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured on server.' });

  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'No message provided.' });

  let learnedContext = '';
  try {
    const kv = createClient({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });
    const patterns = await kv.get('pmar:patterns');
    if (patterns && patterns.topTypes && patterns.topTypes.length > 0) {
      learnedContext = `\n\nLEARNED PATTERNS FROM THIS CLINIC (use to inform confidence and suggestions):
Most common message types seen: ${patterns.topTypes.slice(0, 5).map(t => `"${t.type}" (${t.count} times)`).join(', ')}.
Total messages processed: ${patterns.totalMessages || 0}.
${patterns.recentTrends && patterns.recentTrends.length > 0 ? `Recent emerging types: ${patterns.recentTrends.join(', ')}.` : ''}
Use this context to be more confident in your routing for common message types, and flag any unusual patterns.`;
    }
  } catch (e) {}

  const system = `You are a healthcare clinic triage AI agent. Analyze patient PMAR messages and produce a full action plan for staff to review and approve before anything is sent.

ROUTING RULES:
- PMAR: Administrative tasks, routine stable medication refills, form/document requests, scheduling, referral status, simple non-clinical questions
- E-Visit: New symptoms, worsening conditions, clinical judgment needed, medication changes/reactions, mental health concerns, billable clinical encounters
- Urgent: Self-harm, suicidal ideation, chest pain, severe breathing difficulty, stroke symptoms, emergencies
- Unclear: Cannot determine without more information

STAFF ROLES for assignment:
- Front Desk: scheduling, forms, records requests, general admin
- Medical Assistant (MA): routine refill requests, referral status, simple clinical questions
- Nurse (RN): clinical questions, medication concerns, symptom follow-up
- Clinician (MD/NP): urgent clinical issues, E-Visit candidates, complex cases
- Behavioral Health: mental health, emotional distress, self-harm concerns
${learnedContext}

Respond ONLY with a valid JSON object, no markdown, no extra text:
{"routing":"PMAR|E-Visit|Urgent|Unclear","message_type":"brief category 3-5 words","reasoning":"1-2 sentences explaining the routing decision","priority":"Routine|Same Day|Urgent","assigned_role":"Front Desk|Medical Assistant|Nurse|Clinician|Behavioral Health","assignment_reason":"1 sentence why this role was chosen","suggested_action":"specific next step for staff 1-2 sentences","draft_reply":"professional empathetic patient reply 2-4 sentences ready to send","flag":null,"e_visit_redirect":false,"confidence":"High|Medium|Low","confidence_reason":"1 sentence why this confidence level"}

For flag use: null, "billing_opportunity", "clinical_review_needed", or "emergency"
Set e_visit_redirect to true if patient should be redirected to E-Visit.
Confidence should be High if this matches common learned patterns, Medium if uncertain, Low if unusual or ambiguous.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': apiKey
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1200,
        system,
        messages: [{ role: 'user', content: `Patient PMAR message: "${message}"` }]
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'API error' });

    const raw = data.content
      .map(i => i.type === 'text' ? i.text : '')
      .join('').trim()
      .replace(/^```json\s*/, '').replace(/```$/, '').trim();

    const result = JSON.parse(raw);
    storePattern(result.message_type, result.routing, result.assigned_role).catch(() => {});
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

async function storePattern(messageType, routing, assignedRole) {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return;
  try {
    const kv = createClient({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });
    const dayKey = new Date().toISOString().slice(0, 10);
    await kv.hincrby('pmar:type_counts', messageType, 1);
    await kv.hincrby('pmar:routing_counts', routing, 1);
    await kv.hincrby('pmar:role_counts', assignedRole, 1);
    await kv.hincrby('pmar:daily', dayKey, 1);
    await kv.incr('pmar:total');
    await kv.lpush('pmar:recent_types', messageType);
    await kv.ltrim('pmar:recent_types', 0, 49);

    const [typeCounts, routingCounts, roleCounts, total, recentTypes] = await Promise.all([
      kv.hgetall('pmar:type_counts'),
      kv.hgetall('pmar:routing_counts'),
      kv.hgetall('pmar:role_counts'),
      kv.get('pmar:total'),
      kv.lrange('pmar:recent_types', 0, 49)
    ]);

    const topTypes = Object.entries(typeCounts || {})
      .map(([type, count]) => ({ type, count: parseInt(count) }))
      .sort((a, b) => b.count - a.count).slice(0, 10);

    const recentCounts = {};
    (recentTypes || []).forEach(t => { recentCounts[t] = (recentCounts[t] || 0) + 1; });
    const recentTrends = Object.entries(recentCounts)
      .filter(([, cnt]) => cnt >= 2).sort((a, b) => b[1] - a[1])
      .slice(0, 3).map(([type]) => type);

    await kv.set('pmar:patterns', {
      topTypes, routingCounts: routingCounts || {}, roleCounts: roleCounts || {},
      totalMessages: parseInt(total) || 0, recentTrends, lastUpdated: Date.now()
    });
  } catch (e) {}
}
