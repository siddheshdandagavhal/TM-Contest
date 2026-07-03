// TM Tournament Server v3 - Slot machine spin order + admin-gated rounds + Supabase
const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme123';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_KEY must be set as environment variables');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const STATE_ROW_ID = 1;

app.use(express.json());
app.use(express.static('public'));

const defaultState = {
  tms: ['Aali','Dharma','Praveen','Hyderabad TM','Vishaka','Pankaj','Jyoti','Priyanshi','Shriprasad','Ashutosh','Mayankgiri','Puneet','Pushpa','Apoorv','Manan','Harish'],
  currentRound: 1,
  totalRounds: 12,
  pairings: {},
  paired: [],         // TMs already paired this round
  results: {},
  spinLock: null,
  roundActive: false, // admin must start each round
  currentSpinner: null, // who slot machine has selected to spin next
  lastUpdate: Date.now()
};

async function loadState() {
  try {
    const { data, error } = await supabase
      .from('tournament')
      .select('state')
      .eq('id', STATE_ROW_ID)
      .single();
    
    if (error || !data) {
      console.log('Initializing default state in Supabase');
      await supabase.from('tournament').upsert({
        id: STATE_ROW_ID,
        state: defaultState
      });
      return { ...defaultState };
    }
    // Migrate old states that don't have new fields
    const s = data.state;
    if (s.roundActive === undefined) s.roundActive = false;
    if (s.currentSpinner === undefined) s.currentSpinner = null;
    return s;
  } catch (e) {
    console.error('Load error:', e);
    return { ...defaultState };
  }
}

async function saveState(state) {
  state.lastUpdate = Date.now();
  try {
    const { error } = await supabase
      .from('tournament')
      .upsert({ id: STATE_ROW_ID, state: state });
    if (error) console.error('Save error:', error);
  } catch (e) {
    console.error('Save exception:', e);
  }
  return state;
}

function canCompleteRound(remaining, history) {
  if (remaining.length === 0) return true;
  if (remaining.length % 2 !== 0) return false;
  const first = remaining[0];
  const others = remaining.slice(1);
  for (let i = 0; i < others.length; i++) {
    const partner = others[i];
    const key = [first, partner].sort().join('|');
    if (history.has(key)) continue;
    const rest = others.filter((_, idx) => idx !== i);
    if (canCompleteRound(rest, history)) return true;
  }
  return false;
}

function getValidOpponents(spinner, available, historyArr) {
  const history = new Set(historyArr);
  const candidates = available.filter(p => p !== spinner);
  return candidates.filter(opp => {
    const key = [spinner, opp].sort().join('|');
    if (history.has(key)) return false;
    const remaining = available.filter(p => p !== spinner && p !== opp);
    return canCompleteRound(remaining, history);
  });
}

function buildHistory(pairings) {
  const arr = [];
  Object.values(pairings).forEach(rounds => {
    rounds.forEach(([a, b]) => arr.push([a, b].sort().join('|')));
  });
  return arr;
}

// GET state
app.get('/api/state', async (req, res) => {
  const state = await loadState();
  res.json(state);
});

// POST slot-pull: pick next spinner via slot machine
app.post('/api/slot-pull', async (req, res) => {
  const state = await loadState();
  
  if (!state.roundActive) {
    return res.status(400).json({ error: 'Round has not been started by admin yet' });
  }
  if (state.currentSpinner) {
    return res.status(400).json({ error: `${state.currentSpinner} is already up to spin the wheel` });
  }
  
  const eligible = state.tms.filter(t => !state.paired.includes(t));
  if (eligible.length === 0) {
    return res.status(400).json({ error: 'Round is complete' });
  }
  
  // Pick random unpaired TM as next spinner
  const next = eligible[Math.floor(Math.random() * eligible.length)];
  state.currentSpinner = next;
  
  const saved = await saveState(state);
  res.json({ nextSpinner: next, state: saved });
});

// POST spin: only the currentSpinner can spin
app.post('/api/spin', async (req, res) => {
  const { spinner } = req.body;
  const state = await loadState();

  if (!state.roundActive) {
    return res.status(400).json({ error: 'Round has not been started yet' });
  }
  if (state.currentSpinner !== spinner) {
    return res.status(400).json({ error: `It's ${state.currentSpinner || 'no one'}'s turn to spin, not ${spinner}` });
  }
  if (state.spinLock && Date.now() - state.spinLock.time < 5000) {
    return res.status(409).json({ error: 'Spin in progress' });
  }
  if (state.paired.includes(spinner)) {
    return res.status(400).json({ error: `${spinner} is already paired this round` });
  }

  const available = state.tms.filter(t => !state.paired.includes(t));
  const history = buildHistory(state.pairings);
  const valid = getValidOpponents(spinner, available, history);

  if (valid.length === 0) {
    return res.status(400).json({ error: 'No valid opponents available' });
  }

  const opponent = valid[Math.floor(Math.random() * valid.length)];
  const round = state.currentRound;

  if (!state.pairings[round]) state.pairings[round] = [];
  state.pairings[round].push([spinner, opponent]);
  state.paired.push(spinner, opponent);
  state.spinLock = { spinner, time: Date.now() };
  state.currentSpinner = null; // clear so slot machine can pull next

  const saved = await saveState(state);
  res.json({ spinner, opponent, state: saved });
});

// Admin: start the current round
app.post('/api/start-round', async (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  
  const state = await loadState();
  state.roundActive = true;
  state.currentSpinner = null;
  await saveState(state);
  res.json(state);
});

// Admin: advance round
app.post('/api/advance-round', async (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

  const state = await loadState();
  if (state.currentRound < state.totalRounds) {
    state.currentRound++;
    state.paired = [];
    state.spinLock = null;
    state.roundActive = false;     // next round starts paused
    state.currentSpinner = null;
    await saveState(state);
  }
  res.json(state);
});

// Admin: reset round
app.post('/api/reset-round', async (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

  const state = await loadState();
  delete state.pairings[state.currentRound];
  state.paired = [];
  state.spinLock = null;
  state.currentSpinner = null;
  state.roundActive = false;
  await saveState(state);
  res.json(state);
});

// Admin: clear stuck spinner (in case someone's slot was pulled but they never spun)
app.post('/api/clear-spinner', async (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  
  const state = await loadState();
  state.currentSpinner = null;
  state.spinLock = null;
  await saveState(state);
  res.json(state);
});

// Admin: reset all
app.post('/api/reset-all', async (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

  const state = { ...defaultState, pairings: {}, paired: [], results: {} };
  await saveState(state);
  res.json(state);
});

// Admin: update TMs
app.post('/api/update-tms', async (req, res) => {
  const { password, tms } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  if (!Array.isArray(tms) || tms.length !== 16) {
    return res.status(400).json({ error: 'Need exactly 16 TM names' });
  }

  const state = await loadState();
  state.tms = tms;
  await saveState(state);
  res.json(state);
});

app.listen(PORT, () => {
  console.log(`TM Tournament v3 running on port ${PORT}`);
});
