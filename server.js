const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

// ── Database setup ──────────────────────────────────────────────────────────
const db = new Database(process.env.DB_PATH || './rook.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         TEXT PRIMARY KEY,
    username   TEXT UNIQUE NOT NULL,
    password   TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    remember   INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    expires_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS stats (
    user_id       TEXT PRIMARY KEY,
    games_played  INTEGER DEFAULT 0,
    games_won     INTEGER DEFAULT 0,
    bids_made     INTEGER DEFAULT 0,
    bids_set      INTEGER DEFAULT 0,
    tricks_won    INTEGER DEFAULT 0,
    points_scored INTEGER DEFAULT 0,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);

// ── Auth helpers ────────────────────────────────────────────────────────────
function createSession(userId, remember) {
  const token = uuidv4();
  const now = Math.floor(Date.now() / 1000);
  const expires = now + (remember ? 60 * 60 * 24 * 30 : 60 * 60 * 24); // 30d or 1d
  db.prepare('INSERT INTO sessions (token, user_id, remember, expires_at) VALUES (?,?,?,?)')
    .run(token, userId, remember ? 1 : 0, expires);
  return token;
}

function getUserByToken(token) {
  const now = Math.floor(Date.now() / 1000);
  const session = db.prepare('SELECT * FROM sessions WHERE token=? AND expires_at>?').get(token, now);
  if (!session) return null;
  return db.prepare('SELECT id, username FROM users WHERE id=?').get(session.user_id);
}

function ensureStats(userId) {
  db.prepare('INSERT OR IGNORE INTO stats (user_id) VALUES (?)').run(userId);
}

// ── Express REST endpoints ──────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// Register
app.post('/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
  if (username.length < 2 || username.length > 20) return res.status(400).json({ error: 'Username must be 2-20 characters.' });
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters.' });
  const existing = db.prepare('SELECT id FROM users WHERE LOWER(username)=LOWER(?)').get(username);
  if (existing) return res.status(409).json({ error: 'Username already taken.' });
  const hash = await bcrypt.hash(password, 10);
  const id = uuidv4();
  db.prepare('INSERT INTO users (id, username, password) VALUES (?,?,?)').run(id, username, hash);
  ensureStats(id);
  const token = createSession(id, false);
  res.json({ ok: true, token, username, userId: id });
});

// Login
app.post('/auth/login', async (req, res) => {
  const { username, password, remember } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE LOWER(username)=LOWER(?)').get(username);
  if (!user) return res.status(401).json({ error: 'Invalid username or password.' });
  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(401).json({ error: 'Invalid username or password.' });
  const token = createSession(user.id, !!remember);
  res.json({ ok: true, token, username: user.username, userId: user.id });
});

// Validate token (for remember me)
app.post('/auth/validate', (req, res) => {
  const { token } = req.body;
  const user = getUserByToken(token);
  if (!user) return res.status(401).json({ error: 'Session expired.' });
  res.json({ ok: true, username: user.username, userId: user.id });
});

// Leaderboard
app.get('/leaderboard', (req, res) => {
  const rows = db.prepare(`
    SELECT u.username, s.games_played, s.games_won, s.bids_made, s.bids_set, s.tricks_won, s.points_scored,
      CASE WHEN s.games_played > 0 THEN ROUND(100.0 * s.games_won / s.games_played, 1) ELSE 0 END AS win_pct
    FROM stats s JOIN users u ON u.id = s.user_id
    WHERE s.games_played > 0
    ORDER BY s.games_won DESC, win_pct DESC
    LIMIT 50
  `).all();
  res.json(rows);
});

// Player stats
app.get('/stats/:username', (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE LOWER(username)=LOWER(?)').get(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const stats = db.prepare('SELECT * FROM stats WHERE user_id=?').get(user.id);
  res.json(stats || {});
});

app.get('/health', (_, res) => res.json({ ok: true, rooms: Object.keys(rooms).length }));

// ── Socket.io rooms ─────────────────────────────────────────────────────────
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
  return {
    code: room.code,
    host: room.hostUsername,
    players: room.players.map(p => ({ username: p.username, seat: p.seat, ready: p.ready })),
    started: room.started,
  };
}

io.on('connection', (socket) => {
  // Authenticate socket
  socket.on('auth', ({ token }, cb) => {
    const user = getUserByToken(token);
    if (!user) return cb?.({ ok: false, error: 'Invalid session.' });
    socket.data.userId = user.id;
    socket.data.username = user.username;
    cb?.({ ok: true, username: user.username });
  });

  // Host a room
  socket.on('host', (_, cb) => {
    if (!socket.data.username) return cb?.({ ok: false, error: 'Not authenticated.' });
    const code = makeCode();
    const player = { id: socket.id, userId: socket.data.userId, username: socket.data.username, seat: 0, ready: false };
    rooms[code] = { code, host: socket.id, hostUsername: socket.data.username, players: [player], state: null, started: false };
    socket.join(code);
    socket.data.code = code;
    cb?.({ ok: true, code, seat: 0, room: roomSummary(rooms[code]) });
    io.to(code).emit('room_update', roomSummary(rooms[code]));
  });

  // Join a room
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
    room.players.push({ id: socket.id, userId: socket.data.userId, username: socket.data.username, seat, ready: false });
    socket.join(code);
    socket.data.code = code;
    cb?.({ ok: true, code, seat, room: roomSummary(room) });
    io.to(code).emit('room_update', roomSummary(room));
  });

  // Start game (host only)
  socket.on('start', ({ initialState }, cb) => {
    const room = rooms[socket.data.code];
    if (!room) return cb?.({ ok: false, error: 'Room not found.' });
    if (room.host !== socket.id) return cb?.({ ok: false, error: 'Only the host can start.' });
    if (room.players.length < 2) return cb?.({ ok: false, error: 'Need at least 2 players.' });
    room.started = true;
    room.state = initialState;
    cb?.({ ok: true });
    io.to(room.code).emit('game_started', {
      state: initialState,
      players: room.players.map(p => ({ username: p.username, seat: p.seat })),
    });
  });

  // Game action relay
  socket.on('action', ({ type, payload }) => {
    const room = rooms[socket.data.code];
    if (!room?.started) return;
    socket.to(room.code).emit('action', { type, payload, seat: socket.data.seat, username: socket.data.username });
  });

  // State sync (host sends after resolving each action)
  socket.on('sync_state', ({ state }) => {
    const room = rooms[socket.data.code];
    if (!room) return;
    room.state = state;
    socket.to(room.code).emit('state_sync', { state });
  });

  // Record game result
  socket.on('game_result', ({ winningSeat }) => {
    const room = rooms[socket.data.code];
    if (!room || room.host !== socket.id) return;
    room.players.forEach(p => {
      ensureStats(p.userId);
      const won = p.seat === winningSeat ? 1 : 0;
      db.prepare(`
        UPDATE stats SET games_played=games_played+1, games_won=games_won+?
        WHERE user_id=?
      `).run(won, p.userId);
    });
  });

  // Update individual player stats
  socket.on('player_stats', ({ bidMade, bidSet, tricksWon, pointsScored }) => {
    if (!socket.data.userId) return;
    ensureStats(socket.data.userId);
    db.prepare(`
      UPDATE stats SET
        bids_made=bids_made+?, bids_set=bids_set+?,
        tricks_won=tricks_won+?, points_scored=points_scored+?
      WHERE user_id=?
    `).run(bidMade||0, bidSet||0, tricksWon||0, pointsScored||0, socket.data.userId);
  });

  // Chat
  socket.on('chat', ({ message }) => {
    const room = rooms[socket.data.code];
    if (!room) return;
    io.to(room.code).emit('chat', { username: socket.data.username, message });
  });

  // Disconnect
  socket.on('disconnect', () => {
    const { code, username } = socket.data;
    const room = rooms[code];
    if (!room) return;
    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.players.length === 0) {
      delete rooms[code];
    } else {
      if (room.host === socket.id) room.host = room.players[0].id;
      io.to(code).emit('player_left', { username, room: roomSummary(room) });
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Rook server on port ${PORT}`));
