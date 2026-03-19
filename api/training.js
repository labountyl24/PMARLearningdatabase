const { Redis } = require('@upstash/redis');

const DEFAULT_SCENARIOS = [
  { id: 'scen_001', message: 'Hi, I ran out of my metformin 500mg and need a refill. I have been on it for 3 years without any problems.', correct_routing: 'PMAR', correct_role: 'Medical Assistant', correct_quickaction: 'done_after_reply', explanation: 'This is a routine refill for a stable, long-term medication with no complications reported. Non-clinical staff can handle this without clinical input.', custom: false },
  { id: 'scen_002', message: 'I have been having chest tightness and shortness of breath since this morning. Should I be worried?', correct_routing: 'Urgent', correct_role: 'Clinician', correct_quickaction: 'schedule_visit', explanation: 'Chest tightness and shortness of breath are potential cardiac or pulmonary emergency symptoms. This requires immediate escalation and the patient should be directed to seek urgent care or call 911.', custom: false },
  { id: 'scen_003', message: 'Can you fax my vaccination records to my employer? Their fax number is 612-555-0100.', correct_routing: 'PMAR', correct_role: 'Front Desk', correct_quickaction: 'done_after_reply', explanation: 'This is a simple administrative records request. Front desk staff can process this without any clinical involvement.', custom: false },
  { id: 'scen_004', message: 'I started a new blood pressure medication 2 days ago and now I have a rash on my arms and my lips feel a little swollen.', correct_routing: 'Urgent', correct_role: 'Clinician', correct_quickaction: 'direct_to_evisit', explanation: 'Rash and lip swelling after starting a new medication could indicate a serious allergic reaction (angioedema). This is urgent and requires immediate clinical evaluation.', custom: false },
  { id: 'scen_005', message: 'I do not see my blood test results from last week in MyChart yet. Were they missed?', correct_routing: 'PMAR', correct_role: 'Medical Assistant', correct_quickaction: 'done_after_reply', explanation: 'This is a straightforward results inquiry. Staff can check the chart, verify the status of the labs, and update the patient without clinical input.', custom: false },
  { id: 'scen_006', message: 'I have been feeling really down lately, crying a lot, not sleeping well, and I have lost interest in things I used to enjoy. This has been going on for about a month.', correct_routing: 'E-Visit', correct_role: 'Behavioral Health', correct_quickaction: 'direct_to_evisit', explanation: 'These are classic symptoms of depression that have persisted for a month. This requires clinical evaluation and is best handled through an E-Visit routed to Behavioral Health.', custom: false },
  { id: 'scen_007', message: 'Can you please send a referral to a dermatologist? My doctor mentioned it at my last visit but I have not heard anything.', correct_routing: 'PMAR', correct_role: 'Medical Assistant', correct_quickaction: 'done_after_reply', explanation: 'Referral status follow-up is an administrative task. Staff can check whether the referral was sent and follow up with the patient without clinical input.', custom: false },
  { id: 'scen_008', message: 'My knee has been swollen, painful, and warm to the touch for 5 days. Ibuprofen is not helping at all.', correct_routing: 'E-Visit', correct_role: 'Nurse', correct_quickaction: 'direct_to_both', explanation: 'Persistent joint swelling, pain, and warmth unresponsive to OTC medication requires clinical assessment to rule out infection, gout, or injury. An E-Visit or in-person appointment is appropriate.', custom: false },
  { id: 'scen_009', message: 'I need a prior authorization form filled out for my insurance for my new inhaler.', correct_routing: 'PMAR', correct_role: 'Medical Assistant', correct_quickaction: 'asking_clinician', explanation: 'Prior authorization requires clinician sign-off, but the administrative coordination can be handled by the MA after consulting with the clinician. The Asking a Clinician QuickAction is appropriate here.', custom: false },
  { id: 'scen_010', message: 'I have been having thoughts of hurting myself. I do not know what to do.', correct_routing: 'Urgent', correct_role: 'Behavioral Health', correct_quickaction: 'schedule_visit', explanation: 'Any mention of self-harm requires immediate escalation. This should be treated as a mental health crisis and routed urgently to Behavioral Health or a clinician. The patient should also be provided crisis resources (988).', custom: false }
];

async function getCustomScenarios(kv) {
  try {
    const raw = await kv.get('pmar:custom_scenarios');
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
  } catch (e) { return []; }
}

async function getDeletedDefaults(kv) {
  try {
    const raw = await kv.get('pmar:deleted_default_scenarios');
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
  } catch (e) { return []; }
}

async function getAllScenarios(kv) {
  const custom = await getCustomScenarios(kv);
  const deleted = await getDeletedDefaults(kv);
  const defaults = DEFAULT_SCENARIOS.filter(function(s) {
    return !deleted.includes(s.id);
  });
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
    const mode = req.query && req.query.mode;
    const all = kv ? await getAllScenarios(kv) : DEFAULT_SCENARIOS.slice();
    if (mode === 'manage') {
      // For manage view, also return deleted defaults so they can be restored
      const deleted = kv ? await getDeletedDefaults(kv) : [];
      const deletedScenarios = DEFAULT_SCENARIOS.filter(function(s) { return deleted.includes(s.id); });
      return res.status(200).json({ scenarios: all, deletedDefaults: deletedScenarios });
    }
    const shuffled = all.slice().sort(function() { return Math.random() - 0.5; });
    return res.status(200).json({ scenarios: shuffled });
  }

  if (req.method === 'DELETE') {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Scenario ID required.' });
    if (!kv) return res.status(200).json({ ok: true });
    try {
      const isDefault = DEFAULT_SCENARIOS.some(function(s) { return s.id === id; });
      if (isDefault) {
        // Add to deleted defaults list
        const deleted = await getDeletedDefaults(kv);
        if (!deleted.includes(id)) deleted.push(id);
        await kv.set('pmar:deleted_default_scenarios', JSON.stringify(deleted));
      } else {
        // Remove from custom list
        const custom = await getCustomScenarios(kv);
        await kv.set('pmar:custom_scenarios', JSON.stringify(custom.filter(function(s) { return s.id !== id; })));
      }
      return res.status(200).json({ ok: true });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  if (req.method === 'POST') {
    const body = req.body;

    // Restore a deleted default scenario
    if (body.restore) {
      if (!kv) return res.status(200).json({ ok: true });
      try {
        const deleted = await getDeletedDefaults(kv);
        await kv.set('pmar:deleted_default_scenarios', JSON.stringify(deleted.filter(function(id) { return id !== body.restore; })));
        return res.status(200).json({ ok: true });
      } catch (err) { return res.status(500).json({ error: err.message }); }
    }

    // Evaluate answer
    if (body.scenarioId) {
      const all = kv ? await getAllScenarios(kv) : DEFAULT_SCENARIOS.slice();
      const scenario = all.find(function(s) { return s.id === body.scenarioId; });
      if (!scenario) return res.status(404).json({ error: 'Scenario not found.' });
      const rc = body.staffRouting === scenario.correct_routing;
      const ro = body.staffRole === scenario.correct_role;
      const qc = body.staffQuickaction === scenario.correct_quickaction;
      const score = [rc, ro, qc].filter(Boolean).length;
      if (kv) {
        try {
          await kv.incr('pmar:training_total');
          await kv.incrby('pmar:training_score', score);
          if (rc && ro && qc) await kv.incr('pmar:training_perfect');
          await kv.hincrby('pmar:training_by_scenario', body.scenarioId, 1);
          if (!rc) await kv.hincrby('pmar:training_routing_errors', scenario.correct_routing, 1);
        } catch (e) {}
      }
      return res.status(200).json({ correct: rc && ro && qc, score: score, maxScore: 3, routingCorrect: rc, roleCorrect: ro, quickactionCorrect: qc, correctRouting: scenario.correct_routing, correctRole: scenario.correct_role, correctQuickaction: scenario.correct_quickaction, explanation: scenario.explanation });
    }

    // Save new or updated custom scenario
    const { scenario } = body;
    if (!scenario || !scenario.message || !scenario.correct_routing || !scenario.correct_role || !scenario.correct_quickaction || !scenario.explanation) {
      return res.status(400).json({ error: 'All scenario fields are required.' });
    }
    if (!kv) return res.status(200).json({ ok: true, note: 'Redis not configured.' });
    try {
      const custom = await getCustomScenarios(kv);
      if (scenario.id) {
        const idx = custom.findIndex(function(s) { return s.id === scenario.id; });
        if (idx >= 0) custom[idx] = scenario;
        else { scenario.custom = true; custom.push(scenario); }
      } else {
        scenario.id = 'scen_custom_' + Date.now();
        scenario.custom = true;
        custom.push(scenario);
      }
      await kv.set('pmar:custom_scenarios', JSON.stringify(custom));
      return res.status(200).json({ ok: true, scenario: scenario });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
