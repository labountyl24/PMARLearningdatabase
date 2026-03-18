const { Redis } = require('@upstash/redis');

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
    const kv = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    const patterns = await kv.get('pmar:patterns');
    if (patterns && patterns.topTypes && patterns.topTypes.length > 0) {
      learnedContext = '\n\nLEARNED PATTERNS FROM THIS CLINIC (use to inform confidence and suggestions):\nMost common message types seen: ' + patterns.topTypes.slice(0, 5).map(function(t) { return '"' + t.type + '" (' + t.count + ' times)'; }).join(', ') + '.\nTotal messages processed: ' + (patterns.totalMessages || 0) + '.\n' + (patterns.recentTrends && patterns.recentTrends.length > 0 ? 'Recent emerging types: ' + patterns.recentTrends.join(', ') + '.' : '') + '\nUse this context to be more confident in your routing for common message types, and flag any unusual patterns.';
    }
  } catch (e) {}

  const system = 'You are a healthcare clinic triage AI agent for a HealthPartners clinic. Analyze patient PMAR (Patient Medical Advice Request) messages and produce a full action plan for staff to review and approve before anything is sent.\n\nWHAT PMARs ARE:\nPMARs are patient messages for simple, low-complexity needs. They are handled primarily by non-clinician staff. Clinicians should rarely need to see or respond to PMARs directly. For anything requiring clinical judgment or billing, patients should be redirected to an E-Visit or appointment.\n\nROUTING RULES:\n- PMAR (staff can handle): Administrative tasks, routine stable medication refills, form/document requests, scheduling, referral status, results inquiries, simple non-clinical questions\n- E-Visit (redirect): New or worsening symptoms, clinical judgment needed, medication changes/reactions, mental health concerns, anything billable\n- Urgent (escalate immediately): Self-harm, suicidal ideation, chest pain, severe breathing difficulty, stroke symptoms, any emergency\n- Unclear: Cannot determine without more information\n- Needs Clinician Input: Message can stay as PMAR but staff must verbally consult clinician before replying\n\nSTAFF ROLES for assignment:\n- Front Desk: scheduling, forms, records requests, general admin\n- Medical Assistant (MA): routine refill requests, referral status, simple clinical questions\n- Nurse (RN): clinical questions, medication concerns, symptom follow-up\n- Clinician (MD/NP): urgent clinical issues, E-Visit candidates, complex cases\n- Behavioral Health: mental health, emotional distress, self-harm concerns\n\nEPIC QUICKACTIONS - recommend exactly one based on the message:\n1. done_after_reply: Staff can respond directly and mark done. Use for simple admin, routine refills, records requests, scheduling, results inquiries staff can handle without clinical input.\n2. schedule_visit: Use when patient needs in-person evaluation. Pre-built message: "Thanks for reaching out. Based on your message, it sounds like you\'ll need a clinical evaluation before we can give a recommendation. To make sure you get the best care, please schedule an appointment."\n3. direct_to_evisit: Use when patient needs clinical evaluation digitally. Pre-built message: "Thank you for your message. It sounds like your question needs more time and a clinical evaluation to answer properly. Please start an e-visit so we can get the details we need to help you."\n4. direct_to_both: Use when unclear if in-person or e-visit is needed. Pre-built message: "Based on your message, it sounds like you\'ll need a clinical evaluation before we can give a recommendation. Please schedule an appointment or start an e-visit - whichever works best for you."\n5. asking_clinician: Use when staff needs to verbally consult clinician before replying. Pre-built message: "Thank you for your question. I have reviewed it and want to consult with the clinician before giving you a recommendation. I\'ll follow up with you as soon as I have a chance to connect with them. Thanks for your patience."\n\nEPIC WORKFLOW REMINDERS (include relevant ones in staff_tips):\n- Always use Reply to Patient button, never New Conversation (that creates a separate unlinked thread)\n- After sending a reply, staff must click Sign Visit then manually click Done - messages do NOT auto-complete\n- Billing via PMAR is not recommended - E-Visit is the correct path for billable encounters\n- If a clinician decides billing is appropriate on a PMAR, they must first send dot phrase .PTADVICECONSENTTOBILL and wait for patient consent before communicating the plan of care\n- An encounter diagnosis is required before a visit can be signed if an LOS is entered\n' + learnedContext + '\n\nRespond ONLY with a valid JSON object, no markdown, no extra text:\n{"routing":"PMAR|E-Visit|Urgent|Unclear|Needs Clinician Input","message_type":"brief category 3-5 words","reasoning":"1-2 sentences explaining the routing decision","priority":"Routine|Same Day|Urgent","assigned_role":"Front Desk|Medical Assistant|Nurse|Clinician|Behavioral Health","assignment_reason":"1 sentence why this role was chosen","quickaction":"done_after_reply|schedule_visit|direct_to_evisit|direct_to_both|asking_clinician","quickaction_reason":"1 sentence why this QuickAction was chosen","suggested_action":"specific next step for staff 1-2 sentences","draft_reply":"professional empathetic reply 2-4 sentences or empty string if QuickAction pre-built message applies","staff_tips":["array of 1-3 short relevant Epic workflow reminders for this specific message"],"flag":null,"e_visit_redirect":false,"confidence":"High|Medium|Low","confidence_reason":"1 sentence why this confidence level"}\n\nFor flag use: null, "billing_opportunity", "clinical_review_needed", or "emergency"\nSet e_visit_redirect to true if patient should be redirected to E-Visit.\nFor draft_reply: if quickaction is schedule_visit, direct_to_evisit, or direct_to_both, set draft_reply to empty string since the QuickAction pre-built message should be used instead.';

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
        max_tokens: 1400,
        system: system,
        messages: [{ role: 'user', content: 'Patient PMAR message: "' + message + '"' }]
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error && data.error.message ? data.error.message : 'API error' });

    const raw = data.content
      .map(function(i) { return i.type === 'text' ? i.text : ''; })
      .join('').trim()
      .replace(/^```json\s*/, '').replace(/```$/, '').trim();

    const result = JSON.parse(raw);
    storePattern(result.message_type, result.routing, result.assigned_role).catch(function() {});
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

async function storePattern(messageType, routing, assignedRole) {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return;
  try {
    const kv = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    const dayKey = new Date().toISOString().slice(0, 10);
    await kv.hincrby('pmar:type_counts', messageType, 1);
    await kv.hincrby('pmar:routing_counts', routing, 1);
    await kv.hincrby('pmar:role_counts', assignedRole, 1);
    await kv.hincrby('pmar:daily', dayKey, 1);
    await kv.incr('pmar:total');
    await kv.lpush('pmar:recent_types', messageType);
    await kv.ltrim('pmar:recent_types', 0, 49);

    const typeCounts = await kv.hgetall('pmar:type_counts');
    const routingCounts = await kv.hgetall('pmar:routing_counts');
    const roleCounts = await kv.hgetall('pmar:role_counts');
    const total = await kv.get('pmar:total');
    const recentTypes = await kv.lrange('pmar:recent_types', 0, 49);

    const topTypes = Object.entries(typeCounts || {})
      .map(function(e) { return { type: e[0], count: parseInt(e[1]) }; })
      .sort(function(a, b) { return b.count - a.count; })
      .slice(0, 10);

    const recentCounts = {};
    (recentTypes || []).forEach(function(t) { recentCounts[t] = (recentCounts[t] || 0) + 1; });
    const recentTrends = Object.entries(recentCounts)
      .filter(function(e) { return e[1] >= 2; })
      .sort(function(a, b) { return b[1] - a[1]; })
      .slice(0, 3)
      .map(function(e) { return e[0]; });

    await kv.set('pmar:patterns', JSON.stringify({
      topTypes: topTypes,
      routingCounts: routingCounts || {},
      roleCounts: roleCounts || {},
      totalMessages: parseInt(total) || 0,
      recentTrends: recentTrends,
      lastUpdated: Date.now()
    }));
  } catch (e) {}
}
