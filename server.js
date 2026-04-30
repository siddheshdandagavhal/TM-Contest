// TM Tournament Server
// Simple Express server with JSON file storage for shared state across all users

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const STATE_FILE = path.join(__dirname, 'tournament_state.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme123';

app.use(express.json());
app.use(express.static('public'));

// Default state
const defaultState = {
  tms: ['TM 1','TM 2','TM 3','TM 4','TM 5','TM 6','TM 7','TM 8','TM 9','TM 10','TM 11','TM 12','TM 13','TM 14','TM 15','TM 16'],
  currentRound: 1,
  totalRounds: 8,
  pairings: {},
  paired: [],
  results: {},
  spinLock: null,
  lastUpdate: Date.now()
};

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Load error:', e);
  }
  return { ...defaultState };
}

function saveState(state) {
  state.lastUpdate = Date.now();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Validation: can remaining pool be fully paired without repeats?
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

// GET current state
app.get('/api/state', (req, res) => {
  res.json(loadState());
});

// POST spin - assigns an opponent to the spinner
app.post('/api/spin', (req, res) => {
  const { spinner } = req.body;
  const state = loadState();

  // Lock check (prevent double-spins racing)
  if (state.spinLock && Date.now() - state.spinLock.time < 5000) {
    return res.status(409).json({ error: 'Another spin in progress, try again in a moment' });
  }

  if (!state.tms.includes(spinner)) {
    return res.status(400).json({ error: 'Invalid TM name' });
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

  saveState(state);
  res.json({ spinner, opponent, state });
});

// POST advance round (admin)
app.post('/api/advance-round', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

  const state = loadState();
  if (state.currentRound < state.totalRounds) {
    state.currentRound++;
    state.paired = [];
    state.spinLock = null;
    saveState(state);
  }
  res.json(state);
});

// POST reset round (admin)
app.post('/api/reset-round', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

  const state = loadState();
  delete state.pairings[state.currentRound];
  state.paired = [];
  state.spinLock = null;
  saveState(state);
  res.json(state);
});

// POST reset all (admin)
app.post('/api/reset-all', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

  const state = { ...defaultState, pairings: {}, paired: [], results: {} };
  saveState(state);
  res.json(state);
});

// POST update TM names (admin)
app.post('/api/update-tms', (req, res) => {
  const { password, tms } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  if (!Array.isArray(tms) || tms.length !== 16) {
    return res.status(400).json({ error: 'Need exactly 16 TM names' });
  }

  const state = loadState();
  state.tms = tms;
  saveState(state);
  res.json(state);
});

app.listen(PORT, () => {
  console.log(`TM Tournament running on port ${PORT}`);
});
