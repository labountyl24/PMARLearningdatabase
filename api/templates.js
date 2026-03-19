const { Redis } = require('@upstash/redis');

const DEFAULT_TEMPLATES = [
  { id: 'tpl_refill_stable', category: 'Medication Refill', title: 'Routine refill — stable patient', routing: 'PMAR', role: 'Medical Assistant', body: 'Thank you for reaching out. We have reviewed your refill request and have sent it to your pharmacy. Please allow 2-3 business days for processing. If you have not received your prescription within that time, please contact us again.', custom: false },
  { id: 'tpl_refill_clinician', category: 'Medication Refill', title: 'Refill needs clinician review', routing: 'Needs Clinician Input', role: 'Nurse', body: 'Thank you for your message. Your refill request requires review by your care team before we can process it. We will follow up with you within 1-2 business days. If this is urgent, please call our office directly.', custom: false },
  { id: 'tpl_results_available', category: 'Test Results', title: 'Results are available', routing: 'PMAR', role: 'Medical Assistant', body: 'Thank you for following up. Your results are now available in MyChart under the Test Results section. If you have questions about what your results mean, please submit an E-Visit or schedule an appointment with your provider.', custom: false },
  { id: 'tpl_results_pending', category: 'Test Results', title: 'Results still pending', routing: 'PMAR', role: 'Medical Assistant', body: 'Thank you for checking in. Your results are still being processed by the lab. Most results are available within 3-5 business days. You will receive a notification in MyChart as soon as they are ready. Please reach out again if you have not heard back within that timeframe.', custom: false },
  { id: 'tpl_records_request', category: 'Records & Forms', title: 'Medical records request', routing: 'PMAR', role: 'Front Desk', body: 'Thank you for your request. We have received your records request and will process it within 5-7 business days. You will be notified when your records are ready. Please note that some requests may require a signed authorization form.', custom: false },
  { id: 'tpl_scheduling', category: 'Scheduling', title: 'Appointment scheduling guidance', routing: 'PMAR', role: 'Front Desk', body: 'Thank you for reaching out. You can schedule an appointment online through MyChart, or call our office directly. If you are unsure what type of appointment you need, please describe your concern and we will help direct you to the right care.', custom: false },
  { id: 'tpl_evisit_redirect', category: 'E-Visit Redirect', title: 'Redirect to E-Visit — general', routing: 'E-Visit', role: 'Nurse', body: 'Thank you for your message. Based on what you have described, this question is best addressed through an E-Visit so your care team can properly evaluate your concern and provide a recommendation. Please start an E-Visit through MyChart at your earliest convenience.', custom: false },
  { id: 'tpl_urgent_er', category: 'Urgent', title: 'Urgent — direct to ER or 911', routing: 'Urgent', role: 'Clinician', body: 'Based on what you have described, please seek immediate medical attention. If you are experiencing chest pain, difficulty breathing, or feel this is a life-threatening emergency, please call 911 or go to your nearest emergency room right away. Do not wait for a callback.', custom: false },
  { id: 'tpl_behavioral_health', category: 'Behavioral Health', title: 'Mental health concern — warm handoff', routing: 'E-Visit', role: 'Behavioral Health', body: 'Thank you for reaching out and for trusting us with something so personal. Your care team wants to make sure you get the right support. Please start an E-Visit through MyChart so we can connect you with the appropriate resources. If you are in crisis or having thoughts of harming yourself, please call or text 988 (Suicide and Crisis Lifeline) immediately.', custom: false },
  { id: 'tpl_referral_status', category: 'Referrals', title: 'Referral status check', routing: 'PMAR', role: 'Medical Assistant', body: 'Thank you for following up on your referral. We are checking on the status and will get back to you within 1-2 business days. Referral processing times can vary depending on the specialist and your insurance. If you have not heard from the specialist within 2 weeks of your referral being sent, please reach out to us again.', custom: false }
];

async function getCustomTemplates(kv) {
  try {
    const raw = await kv.get('pmar:templates');
    const all = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
    return all.filter(function(t) { return t.custom !== false; });
  } catch (e) { return []; }
}

async function getDeletedDefaults(kv) {
  try {
    const raw = await kv.get('pmar:deleted_default_templates');
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
  } catch (e) { return []; }
}

async function getAllTemplates(kv) {
  const deleted = await getDeletedDefaults(kv);
  const defaults = DEFAULT_TEMPLATES.filter(function(t) { return !deleted.includes(t.id); });
  const custom = await getCustomTemplates(kv);
  return defaults.concat(custom);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const hasRedis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN;
  const kv = hasRedis ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN }) : null;

  if (req.method === 'GET') {
    if (!kv) return res.status(200).json({ templates: DEFAULT_TEMPLATES });
    try {
      const all = await getAllTemplates(kv);
      return res.status(200).json({ templates: all });
    } catch (err) { return res.status(200).json({ templates: DEFAULT_TEMPLATES }); }
  }

  if (req.method === 'POST') {
    const { template } = req.body;
    if (!template || !template.title || !template.body) return res.status(400).json({ error: 'Template must have a title and body.' });
    if (!kv) return res.status(200).json({ ok: true, note: 'Redis not configured.' });
    try {
      const raw = await kv.get('pmar:templates');
      const saved = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
      template.custom = true;
      if (template.id) {
        const idx = saved.findIndex(function(t) { return t.id === template.id; });
        if (idx >= 0) saved[idx] = template;
        else saved.push(template);
      } else {
        template.id = 'tpl_' + Date.now();
        template.uses = 0;
        saved.push(template);
      }
      await kv.set('pmar:templates', JSON.stringify(saved));
      return res.status(200).json({ ok: true, template: template });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  if (req.method === 'DELETE') {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Template ID required.' });
    if (!kv) return res.status(200).json({ ok: true });
    try {
      const isDefault = DEFAULT_TEMPLATES.some(function(t) { return t.id === id; });
      if (isDefault) {
        const deleted = await getDeletedDefaults(kv);
        if (!deleted.includes(id)) deleted.push(id);
        await kv.set('pmar:deleted_default_templates', JSON.stringify(deleted));
      } else {
        const raw = await kv.get('pmar:templates');
        const saved = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
        await kv.set('pmar:templates', JSON.stringify(saved.filter(function(t) { return t.id !== id; })));
      }
      return res.status(200).json({ ok: true });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
