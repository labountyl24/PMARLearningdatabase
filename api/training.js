const { Redis } = require('@upstash/redis');

const TRAINING_SCENARIOS = [
  {
    id: 'scen_001',
    message: 'Hi, I ran out of my metformin 500mg and need a refill. I have been on it for 3 years without any problems.',
    correct_routing: 'PMAR',
    correct_role: 'Medical Assistant',
    correct_quickaction: 'done_after_reply',
    explanation: 'This is a routine refill for a stable, long-term medication with no complications reported. Non-clinical staff can handle this without clinical input.'
  },
  {
    id: 'scen_002',
    message: 'I have been having chest tightness and shortness of breath since this morning. Should I be worried?',
    correct_routing: 'Urgent',
    correct_role: 'Clinician',
    correct_quickaction: 'schedule_visit',
    explanation: 'Chest tightness and shortness of breath are potential cardiac or pulmonary emergency symptoms. This requires immediate escalation and the patient should be directed to seek urgent care or call 911.'
  },
  {
    id: 'scen_003',
    message: 'Can you fax my vaccination records to my employer? Their fax number is 612-555-0100.',
    correct_routing: 'PMAR',
    correct_role: 'Front Desk',
    correct_quickaction: 'done_after_reply',
    explanation: 'This is a simple administrative records request. Front desk staff can process this without any clinical involvement.'
  },
  {
    id: 'scen_004',
    message: 'I started a new blood pressure medication 2 days ago and now I have a rash on my arms and my lips feel a little swollen.',
    correct_routing: 'Urgent',
    correct_role: 'Clinician',
    correct_quickaction: 'direct_to_evisit',
    explanation: 'Rash and lip swelling after starting a new medication could indicate a serious allergic reaction (angioedema). This is urgent and requires immediate clinical evaluation.'
  },
  {
    id: 'scen_005',
    message: 'I do not see my blood test results from last week in MyChart yet. Were they missed?',
    correct_routing: 'PMAR',
    correct_role: 'Medical Assistant',
    correct_quickaction: 'done_after_reply',
    explanation: 'This is a straightforward results inquiry. Staff can check the chart, verify the status of the labs, and update the patient without clinical input.'
  },
  {
    id: 'scen_006',
    message: 'I have been feeling really down lately, crying a lot, not sleeping well, and I have lost interest in things I used to enjoy. This has been going on for about a month.',
    correct_routing: 'E-Visit',
    correct_role: 'Behavioral Health',
    correct_quickaction: 'direct_to_evisit',
    explanation: 'These are classic symptoms of depression that have persisted for a month. This requires clinical evaluation and is best handled through an E-Visit routed to Behavioral Health.'
  },
  {
    id: 'scen_007',
    message: 'Can you please send a referral to a dermatologist? My doctor mentioned it at my last visit but I have not heard anything.',
    correct_routing: 'PMAR',
    correct_role: 'Medical Assistant',
    correct_quickaction: 'done_after_reply',
    explanation: 'Referral status follow-up is an administrative task. Staff can check whether the referral was sent and follow up with the patient without clinical input.'
  },
  {
    id: 'scen_008',
    message: 'My knee has been swollen, painful, and warm to the touch for 5 days. Ibuprofen is not helping at all.',
    correct_routing: 'E-Visit',
    correct_role: 'Nurse',
    correct_quickaction: 'direct_to_both',
    explanation: 'Persistent joint swelling, pain, and warmth unresponsive to OTC medication requires clinical assessment to rule out infection, gout, or injury. An E-Visit or in-person appointment is appropriate.'
  },
  {
    id: 'scen_009',
    message: 'I need a prior authorization form filled out for my insurance for my new inhaler.',
    correct_routing: 'PMAR',
    correct_role: 'Medical Assistant',
    correct_quickaction: 'asking_clinician',
    explanation: 'Prior authorization requires clinician sign-off, but the administrative coordination can be handled by the MA after consulting with the clinician. The Asking a Clinician QuickAction is appropriate here.'
  },
  {
    id: 'scen_010',
    message: 'I have been having thoughts of hurting myself. I do not know what to do.',
    correct_routing: 'Urgent',
    correct_role: 'Behavioral Health',
    correct_quickaction: 'schedule_visit',
    explanation: 'Any mention of self-harm requires immediate escalation. This should be treated as a mental health crisis and routed urgently to Behavioral Health or a clinician. The patient should also be provided crisis resources (988).'
  }
];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET - return a set of training scenarios
  if (req.method === 'GET') {
    const shuffled = TRAINING_SCENARIOS.slice().sort(function() { return Math.random() - 0.5; });
    return res.status(200).json({ scenarios: shuffled });
  }

  // POST - evaluate a staff answer
  if (req.method === 'POST') {
    const { scenarioId, staffRouting, staffRole, staffQuickaction } = req.body;
    if (!scenarioId) return res.status(400).json({ error: 'Scenario ID required.' });

    const scenario = TRAINING_SCENARIOS.find(function(s) { return s.id === scenarioId; });
    if (!scenario) return res.status(404).json({ error: 'Scenario not found.' });

    const routingCorrect = staffRouting === scenario.correct_routing;
    const roleCorrect = staffRole === scenario.correct_role;
    const quickactionCorrect = staffQuickaction === scenario.correct_quickaction;
    const allCorrect = routingCorrect && roleCorrect && quickactionCorrect;
    const score = [routingCorrect, roleCorrect, quickactionCorrect].filter(Boolean).length;

    // Save training result to Redis if available
    if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
      try {
        const kv = new Redis({
          url: process.env.UPSTASH_REDIS_REST_URL,
          token: process.env.UPSTASH_REDIS_REST_TOKEN,
        });
        await kv.incr('pmar:training_total');
        await kv.incrby('pmar:training_score', score);
        if (allCorrect) await kv.incr('pmar:training_perfect');
        await kv.hincrby('pmar:training_by_scenario', scenarioId, 1);
        if (!routingCorrect) await kv.hincrby('pmar:training_routing_errors', scenario.correct_routing, 1);
      } catch (e) {}
    }

    return res.status(200).json({
      correct: allCorrect,
      score: score,
      maxScore: 3,
      routingCorrect: routingCorrect,
      roleCorrect: roleCorrect,
      quickactionCorrect: quickactionCorrect,
      correctRouting: scenario.correct_routing,
      correctRole: scenario.correct_role,
      correctQuickaction: scenario.correct_quickaction,
      explanation: scenario.explanation
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
