const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

// ── In-memory storage ───────────────────────────────────────────────────────
const users = new Map();       // username.lower -> { id, username, password }
const sessions = new Map();    // token -> { userId, remember, expiresAt }
const stats = new Map();       // userId -> { gamesPlayed, gamesWon, bidsMade, bidsSet, tricksWon, pointsScored }


// Redis persistence — hardcoded Upstash credentials (no env var override to avoid pointing at wrong DB)
const REDIS_URL = 'https://romantic-monitor-131688.upstash.io';
const REDIS_TOKEN = 'gQAAAAAAAgJoAAIgcDEzMmI5OWE5YTU5Nzc0MzA0YTg2MzY4MTYwMGE0MmFhYw';

async function redisCmd(cmd) {
  try {
    const res = await fetch(`${REDIS_URL}/${cmd.map(encodeURIComponent).join('/')}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
    const data = await res.json();
    return data.result;
  } catch(e) { console.warn('Redis error:', e.message); return null; }
}

async function loadDB() {
  try {
    const usersJson = await redisCmd(['GET', 'rook:users']);
    const statsJson = await redisCmd(['GET', 'rook:stats']);
    const sessionsJson = await redisCmd(['GET', 'rook:sessions']);
    if (usersJson) JSON.parse(usersJson).forEach(([k,v]) => users.set(k, v));
    if (statsJson) JSON.parse(statsJson).forEach(([k,v]) => stats.set(k, v));
    if (sessionsJson) JSON.parse(sessionsJson).forEach(([k,v]) => sessions.set(k, v));
    console.log(`Loaded ${users.size} users, ${sessions.size} sessions from Redis`);
  } catch(e) { console.warn('Could not load from Redis:', e.message); }
}

async function saveDB() {
  try {
    await redisCmd(['SET', 'rook:users', JSON.stringify([...users.entries()])]);
    await redisCmd(['SET', 'rook:stats', JSON.stringify([...stats.entries()])]);
    await redisCmd(['SET', 'rook:sessions', JSON.stringify([...sessions.entries()])]);
  } catch(e) { console.warn('Could not save to Redis:', e.message); }
}

function ensureStats(userId) {
  if (!stats.has(userId)) stats.set(userId, {
    gamesPlayed:0, gamesWon:0, bidsMade:0, bidsSet:0,
    tricksWon:0, pointsScored:0, currentStreak:0, bestStreak:0, lawedOff:0, consecutiveBidsMade:0,
    cpuWinsEasy:0, cpuWinsMedium:0, cpuWinsHard:0, leaderboardPoints:0,
    perfectBids:0, shutouts:0, highBidsMade:0,
    dominatorWins:0, soloCarryHands:0, speedRunWins:0,
    bid150Made:0, bid160Made:0,
  });
}

function getAchievements(s) {
  const badges = [];
  // General
  if ((s.gamesWon || 0) >= 1) badges.push({ id: 'first_win', emoji: '🎉', name: 'First Win' });
  if ((s.gamesWon || 0) >= 10) badges.push({ id: 'veteran', emoji: '🏅', name: 'Veteran' });
  if ((s.gamesWon || 0) >= 25) badges.push({ id: 'rook_master', emoji: '👑', name: 'Rook Master' });
  if ((s.currentStreak || 0) >= 3) badges.push({ id: 'on_fire', emoji: '🔥', name: 'On Fire' });
  if ((s.bestStreak || 0) >= 5) badges.push({ id: 'unstoppable', emoji: '⚡', name: 'Unstoppable' });
  if ((s.consecutiveBidsMade || 0) >= 10) badges.push({ id: 'sharpshooter', emoji: '🎯', name: 'Sharpshooter' });
  if ((s.tricksWon || 0) >= 100) badges.push({ id: 'card_shark', emoji: '🃏', name: 'Card Shark' });
  if ((s.lawedOff || 0) >= 5) badges.push({ id: 'lawed_off', emoji: '💀', name: 'Lawed Off' });
  if ((s.bidsMade || 0) + (s.bidsSet || 0) >= 10) {
    const pct = Math.round(100 * (s.bidsMade || 0) / ((s.bidsMade || 0) + (s.bidsSet || 0)));
    if (pct >= 80) badges.push({ id: 'clutch', emoji: '💎', name: 'Clutch Bidder' });
  }
  // CPU / practice
  const cpuTotal = (s.cpuWinsEasy||0) + (s.cpuWinsMedium||0) + (s.cpuWinsHard||0);
  if (cpuTotal >= 1) badges.push({ id: 'first_blood', emoji: '🤖', name: 'First Blood' });
  if ((s.cpuWinsEasy || 0) >= 5) badges.push({ id: 'easy_pickings', emoji: '😤', name: 'Easy Pickings' });
  if ((s.cpuWinsMedium || 0) >= 5) badges.push({ id: 'worthy_opponent', emoji: '💪', name: 'Worthy Opponent' });
  if ((s.cpuWinsHard || 0) >= 5) badges.push({ id: 'big_brain', emoji: '🧠', name: 'Big Brain' });
  if ((s.dominatorWins || 0) >= 1) badges.push({ id: 'dominator', emoji: '👊', name: 'Dominator' });
  if ((s.perfectBids || 0) >= 1) badges.push({ id: 'perfect_bid', emoji: '🎯', name: 'Perfect Bid' });
  if ((s.soloCarryHands || 0) >= 1) badges.push({ id: 'solo_carry', emoji: '🃏', name: 'Solo Carry' });
  if ((s.speedRunWins || 0) >= 1) badges.push({ id: 'speed_runner', emoji: '🏃', name: 'Speed Runner' });
  if ((s.shutouts || 0) >= 1) badges.push({ id: 'shut_out', emoji: '🔇', name: 'Shut Out' });
  if ((s.highBidsMade || 0) >= 1) badges.push({ id: 'showoff', emoji: '🎪', name: 'Showoff' });
  if ((s.bid150Made || 0) >= 1) badges.push({ id: 'bid_150', emoji: '🔥', name: 'Heat Check' });
  if ((s.bid160Made || 0) >= 1) badges.push({ id: 'bid_160', emoji: '💰', name: 'High Roller' });
  return badges;
}

const RANKS = [
  { id: 'five',      label: '5',    icon: '[5]',  minPoints: 15  },
  { id: 'ten',       label: '10',   icon: '[10]', minPoints: 60  },
  { id: 'fourteen',  label: '14',   icon: '[14]', minPoints: 175 },
  { id: 'one',       label: '1',    icon: '[1]',  minPoints: 350 },
  { id: 'rook',      label: 'ROOK', icon: '🐦',  minPoints: 700 },
];

function getPlayerRank(leaderboardPoints, achievementCount) {
  const score = (leaderboardPoints || 0) + (achievementCount || 0) * 10;
  let rank = null;
  for (const r of RANKS) { if (score >= r.minPoints) rank = r; }
  return rank; // null = unranked
}

function createSession(userId, remember) {
  const token = uuidv4();
  const now = Math.floor(Date.now() / 1000);
  const expires = now + (remember ? 60*60*24*30 : 60*60*24);
  sessions.set(token, { userId, remember, expiresAt: expires });
  return token;
}

function getUserByToken(token) {
  const session = sessions.get(token);
  if (!session || session.expiresAt < Math.floor(Date.now()/1000)) return null;
  const user = [...users.values()].find(u => u.id === session.userId);
  return user ? { id: user.id, username: user.username } : null;
}

// ── Express ─────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

app.post('/auth/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
  if (username.length < 2 || username.length > 20) return res.status(400).json({ error: 'Username must be 2-20 characters.' });
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters.' });
  if (users.has(username.toLowerCase())) return res.status(409).json({ error: 'Username already taken.' });
  const hash = await bcrypt.hash(password, 10);
  const id = uuidv4();
  users.set(username.toLowerCase(), { id, username, password: hash });
  ensureStats(id);
  saveDB();
  const token = createSession(id, false);
  res.json({ ok: true, token, username, userId: id });
});

app.post('/auth/login', async (req, res) => {
  const { username, password, remember } = req.body || {};
  const user = users.get((username || '').toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid username or password.' });
  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(401).json({ error: 'Invalid username or password.' });
  const token = createSession(user.id, !!remember);
  res.json({ ok: true, token, username: user.username, userId: user.id });
});

app.post('/auth/validate', (req, res) => {
  const user = getUserByToken((req.body || {}).token);
  if (!user) return res.status(401).json({ error: 'Session expired.' });
  res.json({ ok: true, username: user.username, userId: user.id });
});

app.get('/leaderboard', (_, res) => {
  const rows = [...stats.entries()].map(([userId, s]) => {
    const u = [...users.values()].find(u => u.id === userId);
    if (!u || !s.gamesPlayed) return null;
    const bidTotal = (s.bidsMade || 0) + (s.bidsSet || 0);
    return {
      username: u.username,
      gamesPlayed: s.gamesPlayed || 0,
      gamesWon: s.gamesWon || 0,
      winPct: s.gamesPlayed > 0 ? +(100 * s.gamesWon / s.gamesPlayed).toFixed(1) : 0,
      bidsMade: s.bidsMade || 0,
      bidsSet: s.bidsSet || 0,
      bidPct: bidTotal > 0 ? +(100 * s.bidsMade / bidTotal).toFixed(1) : 0,
      tricksWon: s.tricksWon || 0,
      pointsScored: s.pointsScored || 0,
      currentStreak: s.currentStreak || 0,
      bestStreak: s.bestStreak || 0,
      lawedOff: s.lawedOff || 0,
      cpuWinsEasy: s.cpuWinsEasy || 0,
      cpuWinsMedium: s.cpuWinsMedium || 0,
      cpuWinsHard: s.cpuWinsHard || 0,
      perfectBids: s.perfectBids || 0,
      shutouts: s.shutouts || 0,
      highBidsMade: s.highBidsMade || 0,
      dominatorWins: s.dominatorWins || 0,
      soloCarryHands: s.soloCarryHands || 0,
      speedRunWins: s.speedRunWins || 0,
      achievements: getAchievements(s),
      leaderboardPoints: s.leaderboardPoints || 0,
      rank: getPlayerRank(s.leaderboardPoints, getAchievements(s).length),
    };
  }).filter(Boolean).map(p => ({
    ...p,
    rankScore: p.leaderboardPoints || 0,
  })).sort((a, b) => b.rankScore - a.rankScore).slice(0, 50);
  res.json(rows);
});


app.get('/rooms', (_, res) => {
  const list = Object.values(rooms).map(r => ({
    code: r.code,
    host: r.hostUsername,
    players: r.players.map(p => p.username),
    started: r.started,
    open: !r.started && r.players.length < 4,
  }));
  res.json(list);
});


app.post('/cleanup', (req, res) => {
  const before = Object.keys(rooms).length;
  Object.keys(rooms).forEach(code => {
    if (rooms[code].players.length === 0) delete rooms[code];
  });
  res.json({ ok: true, removed: before - Object.keys(rooms).length, remaining: Object.keys(rooms).length });
});

app.get('/health', (_, res) => res.json({ ok: true, rooms: Object.keys(rooms).length, users: users.size }));

// ── Socket.io ────────────────────────────────────────────────────────────────
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const rooms = {};

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms[code] ? makeCode() : code;
}

function roomSummary(room) {
  return { code: room.code, host: room.hostUsername, players: room.players.map(p => ({ username: p.username, seat: p.seat, ready: p.ready })), started: room.started };
}

io.on('connection', socket => {
  socket.on('auth', ({ token }, cb) => {
    const user = getUserByToken(token);
    if (!user) return cb?.({ ok: false, error: 'Invalid session.' });
    socket.data.userId = user.id;
    socket.data.username = user.username;
    cb?.({ ok: true, username: user.username });
  });

  socket.on('host', (_, cb) => {
    if (!socket.data.username) return cb?.({ ok: false, error: 'Not authenticated.' });
    const code = makeCode();
    const player = { id: socket.id, userId: socket.data.userId, username: socket.data.username, seat: 0, ready: false, team: 0 };
    rooms[code] = { code, host: socket.id, hostUsername: socket.data.username, players: [player], state: null, started: false };
    socket.join(code); socket.data.code = code; socket.data.seat = 0;
    cb?.({ ok: true, code, seat: 0, room: roomSummary(rooms[code]) });
    io.to(code).emit('room_update', roomSummary(rooms[code]));
  });

  socket.on('join', ({ code }, cb) => {
    if (!socket.data.username) return cb?.({ ok: false, error: 'Not authenticated.' });
    code = code.toUpperCase().trim();
    const room = rooms[code];
    if (!room) return cb?.({ ok: false, error: 'Room not found.' });
    if (room.started) return cb?.({ ok: false, error: 'Game already started.' });
    if (room.players.length >= 4) return cb?.({ ok: false, error: 'Room is full.' });
    if (room.players.find(p => p.username.toLowerCase() === socket.data.username.toLowerCase()))
      return cb?.({ ok: false, error: 'You are already in this room.' });
    const seat = room.players.length;
    const team = seat % 2;
    room.players.push({ id: socket.id, userId: socket.data.userId, username: socket.data.username, seat, ready: false, team });
    socket.join(code); socket.data.code = code; socket.data.seat = seat;
    cb?.({ ok: true, code, seat, room: roomSummary(room) });
    io.to(code).emit('room_update', roomSummary(room));
  });

  socket.on('team_change', ({ team }) => {
    const room = rooms[socket.data.code];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (player) player.team = team;
    io.to(socket.data.code).emit('team_update', {
      teams: room.players.map(p => ({ username: p.username, seat: p.seat, team: p.team ?? 0 }))
    });
  });

  socket.on('start', ({ initialState, difficulty }, cb) => {
    const room = rooms[socket.data.code];
    if (!room) return cb?.({ ok: false, error: 'Room not found.' });
    if (room.host !== socket.id) return cb?.({ ok: false, error: 'Only the host can start.' });
    if (room.players.length < 1) return cb?.({ ok: false, error: 'Room is empty.' });
    // Reassign seats based on teams: team 0 → seats 0,2; team 1 → seats 1,3
    const team0 = room.players.filter(p => (p.team ?? p.seat % 2) === 0);
    const team1 = room.players.filter(p => (p.team ?? p.seat % 2) === 1);
    team0.forEach((p, i) => { p.seat = i * 2; });
    team1.forEach((p, i) => { p.seat = i * 2 + 1; });
    room.players.forEach(p => {
      const sock = io.sockets.sockets.get(p.id);
      if (sock) sock.data.seat = p.seat;
    });
    room.started = true; room.state = initialState; room.difficulty = difficulty || 'medium';
    const hostPlayer = room.players.find(p => p.id === socket.id);
    cb?.({ ok: true, seat: hostPlayer?.seat ?? 0 });
    io.to(room.code).emit('game_started', { state: initialState, players: room.players.map(p => ({ username: p.username, seat: p.seat, team: p.team ?? p.seat % 2 })), difficulty: room.difficulty });
  });

  socket.on('action', ({ type, payload }) => {
    const room = rooms[socket.data.code];
    if (!room?.started) return;
    socket.to(room.code).emit('action', { type, payload, username: socket.data.username });
  });

  socket.on('sync_state', ({ state }) => {
    const room = rooms[socket.data.code];
    if (!room) return;
    room.state = state;
    socket.to(room.code).emit('state_sync', { state });
  });

  socket.on('game_result', ({ winningSeat }) => {
    const room = rooms[socket.data.code];
    if (!room || room.host !== socket.id) return;
    room.players.forEach(p => {
      ensureStats(p.userId);
      const s = stats.get(p.userId);
      s.gamesPlayed++; if (p.seat === winningSeat) s.gamesWon++;
    });
  });

  socket.on('player_stats', ({ bidMade, bidSet, lawedOff, tricksWon, pointsScored, won,
    cpuDifficulty, perfectBid, shutout, highBidMade, dominator, soloCarry, speedRun, bid150Made, bid160Made, oneHand }) => {
    if (!socket.data.userId) return;
    ensureStats(socket.data.userId);
    const s = stats.get(socket.data.userId);
    // Capture badges BEFORE updating
    const badgesBefore = new Set(getAchievements(s).map(a => a.id));
    s.gamesPlayed = (s.gamesPlayed || 0) + 1;
    if (won === true) s.gamesWon = (s.gamesWon || 0) + 1;
    if (bidMade) { s.bidsMade++; s.consecutiveBidsMade++; }
    if (bidSet) { s.bidsSet++; s.consecutiveBidsMade = 0; }
    if (lawedOff) s.lawedOff = (s.lawedOff || 0) + 1;
    s.tricksWon += tricksWon || 0;
    s.pointsScored += pointsScored || 0;
    // CPU difficulty wins
    if (won === true && oneHand)                    { s.leaderboardPoints = (s.leaderboardPoints || 0) + 1; } // one hand win (any mode)
    else if (won === true && cpuDifficulty === 'easy')   { s.cpuWinsEasy   = (s.cpuWinsEasy   || 0) + 1; s.leaderboardPoints = (s.leaderboardPoints || 0) + 5; }
    else if (won === true && cpuDifficulty === 'medium') { s.cpuWinsMedium = (s.cpuWinsMedium || 0) + 1; s.leaderboardPoints = (s.leaderboardPoints || 0) + 15; }
    else if (won === true && cpuDifficulty === 'hard')   { s.cpuWinsHard   = (s.cpuWinsHard   || 0) + 1; s.leaderboardPoints = (s.leaderboardPoints || 0) + 30; }
    else if (won === true && !cpuDifficulty)              { s.leaderboardPoints = (s.leaderboardPoints || 0) + 50; } // online win
    // Special game feats
    if (perfectBid) s.perfectBids = (s.perfectBids || 0) + 1;
    if (shutout) s.shutouts = (s.shutouts || 0) + 1;
    if (highBidMade) s.highBidsMade = (s.highBidsMade || 0) + 1;
    if (bid150Made) s.bid150Made = (s.bid150Made || 0) + 1;
    if (bid160Made) s.bid160Made = (s.bid160Made || 0) + 1;
    if (dominator) s.dominatorWins = (s.dominatorWins || 0) + 1;
    if (soloCarry) s.soloCarryHands = (s.soloCarryHands || 0) + 1;
    if (speedRun) s.speedRunWins = (s.speedRunWins || 0) + 1;
    // Streak tracking
    if (won === true) {
      s.currentStreak = (s.currentStreak || 0) + 1;
      s.bestStreak = Math.max(s.bestStreak || 0, s.currentStreak);
    } else if (won === false) {
      s.currentStreak = 0;
    }
    // Capture badges AFTER updating
    const badgesAfter = getAchievements(s);
    const newlyUnlocked = badgesAfter.filter(a => !badgesBefore.has(a.id));
    saveDB();
    // Emit newly unlocked achievements back to this socket
    if (newlyUnlocked.length > 0) {
      socket.emit('achievements_unlocked', { achievements: newlyUnlocked });
    }
  });

  socket.on('chat', ({ message }) => {
    const room = rooms[socket.data.code];
    if (!room) return;
    io.to(room.code).emit('chat', { username: socket.data.username, message });
  });

  socket.on('disconnect', () => {
    const { code, username } = socket.data;
    const room = rooms[code];
    if (!room) return;
    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.players.length === 0) { delete rooms[code]; return; }
    if (room.host === socket.id) room.host = room.players[0].id;
    io.to(code).emit('player_left', { username, room: roomSummary(room) });
  });
});


// Auto-cleanup empty rooms every 60 seconds
setInterval(() => {
  Object.keys(rooms).forEach(code => {
    if (rooms[code].players.length === 0) delete rooms[code];
  });
}, 60000);

const PORT = process.env.PORT || 3001;
loadDB().then(() => {
  console.log('DB ready, starting server...');
  server.listen(PORT, () => console.log(`Rook server on port ${PORT}`));
}).catch(e => {
  console.error('DB load failed, starting anyway:', e.message);
  server.listen(PORT, () => console.log(`Rook server on port ${PORT}`));
});
// deploy test Tue Aug  4 22:28:54 EDT 2026
