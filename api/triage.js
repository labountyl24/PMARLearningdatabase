const { Redis } = require('@upstash/redis');

function scrubPHI(text) {
  if (!text) return text;
  let scrubbed = text;

  // Names - common patterns (Mr/Mrs/Ms/Dr followed by capitalized words)
  scrubbed = scrubbed.replace(/\b(Mr\.?|Mrs\.?|Ms\.?|Miss|Dr\.?|Prof\.?)\s+[A-Z][a-z]+(\s+[A-Z][a-z]+)?\b/g, '[NAME]');

  // MRN / Patient ID patterns
  scrubbed = scrubbed.replace(/\b(MRN|mrn|patient\s*id|chart\s*#?|record\s*#?)\s*:?\s*[A-Z0-9-]{4,12}\b/gi, '[MRN]');

  // Social Security Numbers
  scrubbed = scrubbed.replace(/\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/g, '[SSN]');

  // Phone numbers
  scrubbed = scrubbed.replace(/\b(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[PHONE]');

  // Email addresses
  scrubbed = scrubbed.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '[EMAIL]');

  // Dates of birth patterns (MM/DD/YYYY, MM-DD-YYYY, Month DD YYYY)
  scrubbed = scrubbed.replace(/\b(0?[1-9]|1[0-2])[\/\-](0?[1-9]|[12]\d|3[01])[\/\-](19|20)\d{2}\b/g, '[DATE]');
  scrubbed = scrubbed.replace(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+(19|20)\d{2}\b/gi, '[DATE]');

  // Street addresses
  scrubbed = scrubbed.replace(/\b\d+\s+[A-Z][a-z]+(\s+[A-Z][a-z]+)?\s+(Street|St|Avenue|Ave|Boulevard|Blvd|Road|Rd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl)\b/gi, '[ADDRESS]');

  // ZIP codes
  scrubbed = scrubbed.replace(/\b\d{5}(-\d{4})?\b/g, '[ZIP]');

  // Fax numbers (already covered by phone but explicit label)
  scrubbed = scrubbed.replace(/\bfax\s*:?\s*\[PHONE\]/gi, 'fax: [FAX]');

  return scrubbed;
}

function detectPHI(text) {
  if (!text) return [];
  const found = [];

  if (/\b(Mr\.?|Mrs\.?|Ms\.?|Miss|Dr\.?)\s+[A-Z][a-z]+/g.test(text)) found.push('patient name');
  if (/\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/.test(text)) found.push('Social Security Number');
  if (/\b(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(text)) found.push('phone number');
  if (/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/.test(text)) found.push('email address');
  if (/\b(0?[1-9]|1[0-2])[\/\-](0?[1-9]|[12]\d|3[01])[\/\-](19|20)\d{2}\b/.test(text)) found.push('date of birth');
  if (/\b\d+\s+[A-Z][a-z]+\s+(Street|St|Avenue|Ave|Boulevard|Blvd|Road|Rd|Lane|Ln|Drive|Dr)\b/i.test(text)) found.push('street address');
  if (/(MRN|patient\s*id|chart\s*#)/i.test(text)) found.push('patient ID or MRN');

  return found;
}

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

  // Scrub PHI before sending to Anthropic API
  const scrubbedMessage = scrubPHI(message);
  const phiDetected = detectPHI(message);

  let learnedContext = '';
  try {
    const kv = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    const patternsRaw = await kv.get('pmar:patterns');
    const patterns = typeof patternsRaw === 'string' ? JSON.parse(patternsRaw) : patternsRaw;
    if (patterns && patterns.topTypes && patterns.topTypes.length > 0) {
      learnedContext = '\n\nLEARNED PATTERNS FROM THIS CLINIC (use to inform confidence and suggestions):\nMost common message types seen: ' + patterns.topTypes.slice(0, 5).map(function(t) { return '"' + t.type + '" (' + t.count + ' times)'; }).join(', ') + '.\nTotal messages processed: ' + (patterns.totalMessages || 0) + '.\n' + (patterns.recentTrends && patterns.recentTrends.length > 0 ? 'Recent emerging types: ' + patterns.recentTrends.join(', ') + '.' : '') + '\nUse this context to be more confident in your routing for common message types, and flag any unusual patterns.';
    }
  } catch (e) {}

  const system = 'You are a healthcare clinic triage AI agent for a HealthPartners clinic. Analyze patient PMAR (Patient Medical Advice Request) messages and produce a full action plan for staff to review and approve before anything is sent.\n\nNOTE: PHI has been automatically scrubbed from this message before it reached you. Placeholders like [NAME], [PHONE], [DATE], [ADDRESS] may appear — treat them as redacted patient information.\n\nWHAT PMARs ARE:\nPMARs are patient messages for simple, low-complexity needs. They are handled primarily by non-clinician staff. Clinicians should rarely need to see or respond to PMARs directly. For anything requiring clinical judgment or billing, patients should be redirected to an E-Visit or appointment.\n\nROUTING RULES:\n- PMAR (staff can handle): Administrative tasks, routine stable medication refills, form/document requests, scheduling, referral status, results inquiries, simple non-clinical questions\n- E-Visit (redirect): New or worsening symptoms, clinical judgment needed, medication changes/reactions, mental health concerns, anything billable\n- Urgent (escalate immediately): Self-harm, suicidal ideation, chest pain, severe breathing difficulty, stroke symptoms, any emergency\n- Unclear: Cannot determine without more information\n- Needs Clinician Input: Message can stay as PMAR but staff must verbally consult clinician before replying\n\nSTAFF ROLES for assignment:\n- Front Desk: scheduling, forms, records requests, general admin\n- Medical Assistant (MA): routine refill requests, referral status, simple clinical questions\n- Nurse (RN): clinical questions, medication concerns, symptom follow-up\n- Clinician (MD/NP): urgent clinical issues, E-Visit candidates, complex cases\n- Behavioral Health: mental health, emotional distress, self-harm concerns\n\nEPIC QUICKACTIONS - recommend exactly one based on the message:\n1. done_after_reply: Staff can respond directly and mark done.\n2. schedule_visit: Patient needs in-person evaluation.\n3. direct_to_evisit: Patient needs clinical evaluation digitally.\n4. direct_to_both: Unclear if in-person or e-visit needed.\n5. asking_clinician: Staff needs to verbally consult clinician before replying.\n\nEPIC WORKFLOW REMINDERS:\n- Always use Reply to Patient button, never New Conversation\n- After sending a reply, staff must click Sign Visit then manually click Done\n- Billing via PMAR is not recommended\n- If billing on PMAR, use .PTADVICECONSENTTOBILL and wait for consent\n- Encounter diagnosis required before signing if LOS entered\n' + learnedContext + '\n\nRespond ONLY with a valid JSON object, no markdown, no extra text:\n{"routing":"PMAR|E-Visit|Urgent|Unclear|Needs Clinician Input","message_type":"brief category 3-5 words","reasoning":"1-2 sentences","priority":"Routine|Same Day|Urgent","assigned_role":"Front Desk|Medical Assistant|Nurse|Clinician|Behavioral Health","assignment_reason":"1 sentence","quickaction":"done_after_reply|schedule_visit|direct_to_evisit|direct_to_both|asking_clinician","quickaction_reason":"1 sentence","suggested_action":"1-2 sentences","draft_reply":"2-4 sentences or empty string if QuickAction pre-built message applies","staff_tips":["1-3 Epic workflow reminders"],"flag":null,"e_visit_redirect":false,"confidence":"High|Medium|Low","confidence_reason":"1 sentence"}\n\nFor flag: null, "billing_opportunity", "clinical_review_needed", or "emergency"\nSet e_visit_redirect true if redirecting to E-Visit.\nSet draft_reply to empty string if quickaction is schedule_visit, direct_to_evisit, or direct_to_both.';

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
        messages: [{ role: 'user', content: 'Patient PMAR message: "' + scrubbedMessage + '"' }]
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error && data.error.message ? data.error.message : 'API error' });

    const raw = data.content
      .map(function(i) { return i.type === 'text' ? i.text : ''; })
      .join('').trim()
      .replace(/^```json\s*/, '').replace(/```$/, '').trim();

    const result = JSON.parse(raw);

    // Add PHI scrub info to result so frontend can show warning
    result.phiDetected = phiDetected;
    result.phiScrubbed = phiDetected.length > 0;

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
