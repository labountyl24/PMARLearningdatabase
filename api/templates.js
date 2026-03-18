const { Redis } = require('@upstash/redis');

const DEFAULT_TEMPLATES = [
  {
    id: 'tpl_refill_stable',
    category: 'Medication Refill',
    title: 'Routine refill — stable patient',
    routing: 'PMAR',
    role: 'Medical Assistant',
    body: 'Thank you for reaching out. We have reviewed your refill request and have sent it to your pharmacy. Please allow 2-3 business days for processing. If you have not received your prescription within that time, please contact us again.',
    approved: true,
    uses: 0
  },
  {
    id: 'tpl_refill_clinician',
    category: 'Medication Refill',
    title: 'Refill needs clinician review',
    routing: 'Needs Clinician Input',
    role: 'Nurse',
    body: 'Thank you for your message. Your refill request requires review by your care team before we can process it. We will follow up with you within 1-2 business days. If this is urgent, please call our office directly.',
    approved: true,
    uses: 0
  },
  {
    id: 'tpl_results_available',
    category: 'Test Results',
    title: 'Results are available',
    routing: 'PMAR',
    role: 'Medical Assistant',
    body: 'Thank you for following up. Your results are now available in MyChart under the Test Results section. If you have questions about what your results mean, please submit an E-Visit or schedule an appointment with your provider.',
    approved: true,
    uses: 0
  },
  {
    id: 'tpl_results_pending',
    category: 'Test Results',
    title: 'Results still pending',
    routing: 'PMAR',
    role: 'Medical Assistant',
    body: 'Thank you for checking in. Your results are still being processed by the lab. Most results are available within 3-5 business days. You will receive a notification in MyChart as soon as they are ready. Please reach out again if you have not heard back within that timeframe.',
    approved: true,
    uses: 0
  },
  {
    id: 'tpl_records_request',
    category: 'Records & Forms',
    title: 'Medical records request',
    routing: 'PMAR',
    role: 'Front Desk',
    body: 'Thank you for your request. We have received your records request and will process it within 5-7 business days. You will be notified when your records are ready. Please note that some requests may require a signed authorization form.',
    approved: true,
    uses: 0
  },
  {
    id: 'tpl_scheduling',
    category: 'Scheduling',
    title: 'Appointment scheduling guidance',
    routing: 'PMAR',
    role: 'Front Desk',
    body: 'Thank you for reaching out. You can schedule an appointment online through MyChart, or call our office directly. If you are unsure what type of appointment you need, please describe your concern and we will help direct you to the right care.',
    approved: true,
    uses: 0
  },
  {
    id: 'tpl_evisit_redirect',
    category: 'E-Visit Redirect',
    title: 'Redirect to E-Visit — general',
    routing: 'E-Visit',
    role: 'Nurse',
    body: 'Thank you for your message. Based on what you have described, this question is best addressed through an E-Visit so your care team can properly evaluate your concern and provide a recommendation. Please start an E-Visit through MyChart at your earliest convenience.',
    approved: true,
    uses: 0
  },
  {
    id: 'tpl_urgent_er',
    category: 'Urgent',
    title: 'Urgent — direct to ER or 911',
    routing: 'Urgent',
    role: 'Clinician',
    body: 'Based on what you have described, please seek immediate medical attention. If you are experiencing chest pain, difficulty breathing, or feel this is a life-threatening emergency, please call 911 or go to your nearest emergency room right away. Do not wait for a callback.',
    approved: true,
    uses: 0
  },
  {
    id: 'tpl_behavioral_health',
    category: 'Behavioral Health',
    title: 'Mental health concern — warm handoff',
    routing: 'E-Visit',
    role: 'Behavioral Health',
    body: 'Thank you for reaching out and for trusting us with something so personal. Your care team wants to make sure you get the right support. Please start an E-Visit through MyChart so we can connect you with the appropriate resources. If you are in crisis or having thoughts of harming yourself, please call or text 988 (Suicide and Crisis Lifeline) immediately.',
    approved: true,
    uses: 0
  },
  {
    id: 'tpl_referral_status',
    category: 'Referrals',
    title: 'Referral status check',
    routing: 'PMAR',
    role: 'Medical Assistant',
    body: 'Thank you for following up on your referral. We are checking on the status and will get back to you within 1-2 business days. Referral processing times can vary depending on the specialist and your insurance. If you have not heard from the specialist within 2 weeks of your referral being sent, please reach out to us again.',
    approved: true,
    uses: 0
  }
];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const hasRedis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN;

  // GET - return all templates
  if (req.method === 'GET') {
    if (!hasRedis) return res.status(200).json({ templates: DEFAULT_TEMPLATES });
    try {
      const kv = new (require('@upstash/redis').Redis)({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      });
      const raw = await kv.get('pmar:templates');
      const saved = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
      return res.status(200).json({ templates: saved || DEFAULT_TEMPLATES });
    } catch (err) {
      return res.status(200).json({ templates: DEFAULT_TEMPLATES });
    }
  }

  // POST - save a new template or update existing
  if (req.method === 'POST') {
    const { template } = req.body;
    if (!template || !template.title || !template.body) {
      return res.status(400).json({ error: 'Template must have a title and body.' });
    }
    if (!hasRedis) return res.status(200).json({ ok: true, note: 'Redis not configured.' });
    try {
      const kv = new (require('@upstash/redis').Redis)({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      });
      const raw = await kv.get('pmar:templates');
      const templates = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : DEFAULT_TEMPLATES.slice();
      if (template.id) {
        // Update existing
        const idx = templates.findIndex(function(t) { return t.id === template.id; });
        if (idx >= 0) templates[idx] = template;
        else templates.push(template);
      } else {
        // New template
        template.id = 'tpl_' + Date.now();
        template.uses = 0;
        template.approved = false;
        templates.push(template);
      }
      await kv.set('pmar:templates', JSON.stringify(templates));
      return res.status(200).json({ ok: true, template: template });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // DELETE - remove a template
  if (req.method === 'DELETE') {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Template ID required.' });
    if (!hasRedis) return res.status(200).json({ ok: true });
    try {
      const kv = new (require('@upstash/redis').Redis)({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      });
      const raw = await kv.get('pmar:templates');
      const templates = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
      const filtered = templates.filter(function(t) { return t.id !== id; });
      await kv.set('pmar:templates', JSON.stringify(filtered));
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
