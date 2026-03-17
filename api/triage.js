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
- Clinician (MD/NP): urg
