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


const fs = require('fs');
const DB_FILE = process.env.DB_PATH || './data.json';

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (d.users) d.users.forEach(([k,v]) => users.set(k, v));
      if (d.stats) d.stats.forEach(([k,v]) => stats.set(k, v));
    }
  } catch(e) { console.warn('Could not load DB:', e.message); }
}

function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: [...users.entries()], stats: [...stats.entries()] }));
  } catch(e) { console.warn('Could not save DB:', e.message); }
}

function ensureStats(userId) {
  if (!stats.has(userId)) stats.set(userId, { gamesPlayed:0, gamesWon:0, bidsMade:0, bidsSet:0, tricksWon:0, pointsScored:0 });
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
    return { username: u?.username, ...s, winPct: s.gamesPlayed > 0 ? +(100*s.gamesWon/s.gamesPlayed).toFixed(1) : 0 };
  }).filter(r => r.username && r.gamesPlayed > 0).sort((a,b) => b.gamesWon - a.gamesWon).slice(0, 50);
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
    io.to(room.code).emit('game_started', { state: initialState, players: room.players.map(p => ({ username: p.username, seat: p.seat })), difficulty: room.difficulty });
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

  socket.on('player_stats', ({ bidMade, bidSet, tricksWon, pointsScored }) => {
    if (!socket.data.userId) return;
    ensureStats(socket.data.userId);
    const s = stats.get(socket.data.userId);
    s.bidsMade += bidMade||0; s.bidsSet += bidSet||0;
    s.tricksWon += tricksWon||0; s.pointsScored += pointsScored||0;
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

loadDB();
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Rook server on port ${PORT}`));
// deploy test Tue Aug  4 22:28:54 EDT 2026
