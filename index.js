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
const onlineSockets = new Map(); // userId -> socketId


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
    hatTrickWins:0, bloodMoneyWins:0, circusActWins:0, slowBurnWins:0,
    pointMagnetWins:0, wildCardWins:0, tidalWaveWins:0,
    stoneWallGames:0, consecutiveGamesNotSet:0,
    rookieOnlineWins:0, perfectGames:0, kingOfTable:false,
    perfectBids:0, shutouts:0, highBidsMade:0,
    dominatorWins:0, soloCarryHands:0, speedRunWins:0,
    bid150Made:0, bid160Made:0,
    rookTrickWins:0, cleanSweeps:0, ghostWins:0, gamblerBids:0,
    nonBidderWins:0, clutchRookWins:0, bombSquads:0, comebackWins:0,
    classicWins:0, quickWins:0, oneHandWins:0,
    warOfAttritionWins:0, fiveHundredWins:0, speedsterWins:0, allInWins:0,
  });
}

function getAchievements(s) {
  const badges = [];
  // General
  if ((s.gamesWon || 0) >= 1) badges.push({ id: 'first_win', emoji: '🎉', name: 'First Win', desc: 'Win your first game' , xp: 5});
  if ((s.gamesWon || 0) >= 10) badges.push({ id: 'veteran', emoji: '🏅', name: 'Veteran', desc: 'Win 10 games' , xp: 10});
  if ((s.gamesWon || 0) >= 25) badges.push({ id: 'rook_master', emoji: '👑', name: 'Rook Master', desc: 'Win 25 games' , xp: 25});
  if ((s.currentStreak || 0) >= 3) badges.push({ id: 'on_fire', emoji: '🔥', name: 'On Fire', desc: '3 win streak' , xp: 10});
  if ((s.bestStreak || 0) >= 5) badges.push({ id: 'unstoppable', emoji: '⚡', name: 'Unstoppable', desc: '5 win streak' , xp: 20});
  if ((s.consecutiveBidsMade || 0) >= 10) badges.push({ id: 'sharpshooter', emoji: '🎯', name: 'Sharpshooter', desc: 'Make 10 bids in a row' , xp: 15});
  if ((s.tricksWon || 0) >= 100) badges.push({ id: 'card_shark', emoji: '🃏', name: 'Card Shark', desc: 'Win 100 tricks' , xp: 15});
  if ((s.lawedOff || 0) >= 5) badges.push({ id: 'lawed_off', emoji: '💀', name: 'Lawed Off', desc: 'Get lawed off 5 times' , xp: 8});
  if ((s.bidsMade || 0) + (s.bidsSet || 0) >= 10) {
    const pct = Math.round(100 * (s.bidsMade || 0) / ((s.bidsMade || 0) + (s.bidsSet || 0)));
    if (pct >= 80) badges.push({ id: 'clutch', emoji: '💎', name: 'Clutch Bidder', desc: '80%+ bid success rate' , xp: 25});
  }
  // CPU / practice
  const cpuTotal = (s.cpuWinsEasy||0) + (s.cpuWinsMedium||0) + (s.cpuWinsHard||0);
  if (cpuTotal >= 1) badges.push({ id: 'first_blood', emoji: '🤖', name: 'First Blood', desc: 'Beat the CPU at least once' , xp: 5});
  if ((s.cpuWinsEasy || 0) >= 5) badges.push({ id: 'easy_pickings', emoji: '😤', name: 'Easy Pickings', desc: 'Win 5 games on Easy' , xp: 10});
  if ((s.cpuWinsMedium || 0) >= 5) badges.push({ id: 'worthy_opponent', emoji: '💪', name: 'Worthy Opponent', desc: 'Win 5 games on Medium' , xp: 15});
  if ((s.cpuWinsHard || 0) >= 5) badges.push({ id: 'big_brain', emoji: '🧠', name: 'Big Brain', desc: 'Win 5 games on Hard' , xp: 25});
  if ((s.dominatorWins || 0) >= 1) badges.push({ id: 'dominator', emoji: '👊', name: 'Dominator', desc: 'Beat Hard CPU holding them under 100 pts' , xp: 30});
  if ((s.perfectBids || 0) >= 1) badges.push({ id: 'perfect_bid', emoji: '🎯', name: 'Perfect Bid', desc: 'Make your bid exactly' , xp: 8});
  if ((s.soloCarryHands || 0) >= 1) badges.push({ id: 'solo_carry', emoji: '🃏', name: 'Solo Carry', desc: 'Score 140+ pts in a single hand' , xp: 20});
  if ((s.speedRunWins || 0) >= 1) badges.push({ id: 'speed_runner', emoji: '🏃', name: 'Speed Runner', desc: 'Win a game in 5 hands or less' , xp: 15});
  if ((s.shutouts || 0) >= 1) badges.push({ id: 'shut_out', emoji: '🔇', name: 'Shut Out', desc: 'Hold opponents to 0 pts in a hand' , xp: 20});
  if ((s.highBidsMade || 0) >= 1) badges.push({ id: 'showoff', emoji: '🎪', name: 'Showoff', desc: 'Bid 170+ and make it' , xp: 25});
  if ((s.bid150Made || 0) >= 1) badges.push({ id: 'bid_150', emoji: '🔥', name: 'Heat Check', desc: 'Bid 150 and make it' , xp: 15});
  if ((s.bid160Made || 0) >= 1) badges.push({ id: 'bid_160', emoji: '💰', name: 'High Roller', desc: 'Bid 160 and make it' , xp: 20});
  // New achievements
  if ((s.rookTrickWins || 0) >= 1) badges.push({ id: 'bird_catcher', emoji: '🦅', name: 'Bird Catcher', desc: 'Win a trick with the Rook card' , xp: 10});
  if ((s.cleanSweeps || 0) >= 1) badges.push({ id: 'clean_sweep', emoji: '🌪️', name: 'Clean Sweep', desc: 'Win every trick in a hand' , xp: 30});
  if ((s.ghostWins || 0) >= 1) badges.push({ id: 'ghost', emoji: '👻', name: 'Ghost', desc: 'Win a game without ever bidding' , xp: 25});
  if ((s.consecutiveBidsMade || 0) >= 3) badges.push({ id: 'ice_cold', emoji: '🧊', name: 'Ice Cold', desc: 'Make 3 bids in a row without being set' , xp: 15});
  if ((s.gamblerBids || 0) >= 1) badges.push({ id: 'gambler', emoji: '🎭', name: 'Gambler', desc: 'Bid 145+ and make it' , xp: 20});
  if ((s.gamesWon || 0) >= 50) badges.push({ id: 'champion', emoji: '🏆', name: 'Champion', desc: 'Win 50 games' , xp: 40});
  if ((s.gamesWon || 0) >= 100) badges.push({ id: 'legend', emoji: '🌟', name: 'Legend', desc: 'Win 100 games' , xp: 50});
  if ((s.hatTrickWins||0) >= 1) badges.push({ id: 'hat_trick', emoji: '🎩', name: 'Hat Trick', desc: 'Win 3 hands in a row in one game' , xp: 20});
  if ((s.bloodMoneyWins||0) >= 1) badges.push({ id: 'blood_money', emoji: '🩸', name: 'Blood Money', desc: 'Win a hand with 150+ total trick points' , xp: 15});
  if ((s.circusActWins||0) >= 1) badges.push({ id: 'circus_act', emoji: '🎪', name: 'Circus Act', desc: 'Bid 125 and score exactly 125' , xp: 20});
  if ((s.slowBurnWins||0) >= 1) badges.push({ id: 'slow_burn', emoji: '🐢', name: 'Slow Burn', desc: 'Win a game lasting 10+ hands' , xp: 20});
  if ((s.pointMagnetWins||0) >= 1) badges.push({ id: 'point_magnet', emoji: '🧲', name: 'Point Magnet', desc: 'Score 200+ pts in a single hand' , xp: 25});
  if ((s.wildCardWins||0) >= 1) badges.push({ id: 'wild_card', emoji: '🃏', name: 'Wild Card', desc: 'Win a hand as dealer after being lawed off' , xp: 20});
  if ((s.tidalWaveWins||0) >= 1) badges.push({ id: 'tidal_wave', emoji: '🌊', name: 'Tidal Wave', desc: 'Win 5 consecutive tricks in a hand' , xp: 25});
  if ((s.stoneWallGames||0) >= 3) badges.push({ id: 'stone_wall', emoji: '🧱', name: 'Stone Wall', desc: 'Win 3 games without being set' , xp: 30});
  if ((s.rookieOnlineWins||0) >= 1) badges.push({ id: 'rookie', emoji: '👶', name: 'Rookie', desc: 'Win your first online game' , xp: 5});
  if ((s.gamesWon||0) >= 10) badges.push({ id: 'night_owl', emoji: '🌙', name: 'Night Owl', desc: 'Win 10 games total' , xp: 10});
  if ((s.perfectGames||0) >= 1) badges.push({ id: 'perfect_game', emoji: '💯', name: 'Perfect Game', desc: 'Win without opponents scoring any points' , xp: 40});
  if (s.kingOfTable) badges.push({ id: 'king_table', emoji: '🦁', name: 'King of the Table', desc: 'Hold the #1 leaderboard spot' , xp: 40});
  const _totalScore = (s.leaderboardPoints||0) + badges.length * 10;
  let _curRank = null; for (const r of RANKS) { if (_totalScore >= r.minPoints) _curRank = r; }
  if (_curRank) badges.push({ id: 'graduated', emoji: '🎓', name: 'Graduated', desc: `Reached rank ${_curRank.label}`, xp: 10 });
  if ((s.nonBidderWins || 0) >= 25) badges.push({ id: 'team_player', emoji: '🤝', name: 'Team Player', desc: 'Win 25 games as the non-bidding team' , xp: 25});
  if ((s.clutchRookWins || 0) >= 1) badges.push({ id: 'clutch_rook', emoji: '🔑', name: 'The Key', desc: 'Win the last trick with the Rook card' , xp: 20});
  if ((s.bombSquads || 0) >= 1) badges.push({ id: 'bomb_squad', emoji: '💥', name: 'Bomb Squad', desc: 'Use Rook to steal a trick worth 30+ pts' , xp: 25});
  if ((s.comebackWins || 0) >= 1) badges.push({ id: 'comeback_kid', emoji: '📈', name: 'Comeback Kid', desc: 'Win while trailing by 30+ pts' , xp: 20});
  // Mode-specific achievements
  if ((s.classicWins||0) >= 5) badges.push({ id: 'marathon_man', emoji: '🏰', name: 'Marathon Man', desc: 'Win 5 Classic games' , xp: 15});
  if ((s.classicWins||0) >= 25) badges.push({ id: 'classic_champ', emoji: '👑', name: 'Classic Champion', desc: 'Win 25 Classic games' , xp: 35});
  if ((s.warOfAttritionWins||0) >= 1) badges.push({ id: 'war_attrition', emoji: '⚔️', name: 'War of Attrition', desc: 'Win a Classic game lasting 15+ hands' , xp: 25});
  if ((s.fiveHundredWins||0) >= 1) badges.push({ id: 'five_hundred', emoji: '💪', name: '500 Club', desc: 'Win a Classic game with 500+ points' , xp: 20});
  if ((s.quickWins||0) >= 5) badges.push({ id: 'quick_draw', emoji: '⚡', name: 'Quick Draw', desc: 'Win 5 Quick Games' , xp: 10});
  if ((s.quickWins||0) >= 30) badges.push({ id: 'quick_thirty', emoji: '🔁', name: 'Quick Thirty', desc: 'Win 30 Quick Games' , xp: 30});
  if ((s.speedsterWins||0) >= 1) badges.push({ id: 'speedster', emoji: '🏎️', name: 'Speedster', desc: 'Win a Quick Game in 3 hands or less' , xp: 15});
  if ((s.oneHandWins||0) >= 1) badges.push({ id: 'one_shot', emoji: '☝️', name: 'One Shot', desc: 'Win your first One Hand game' , xp: 5});
  if ((s.oneHandWins||0) >= 5) badges.push({ id: 'one_and_done', emoji: '🃏', name: 'One and Done', desc: 'Win 5 One Hand games' , xp: 10});
  if ((s.oneHandWins||0) >= 25) badges.push({ id: 'high_stakes', emoji: '🎰', name: 'High Stakes', desc: 'Win 25 One Hand games' , xp: 30});
  if ((s.allInWins||0) >= 1) badges.push({ id: 'all_in', emoji: '💣', name: 'All In', desc: 'Win a One Hand game with 180+ pts' , xp: 20});
  const badgeCount = badges.length;
  if (badgeCount >= 10) badges.push({ id: 'decorated', emoji: '🎖️', name: 'Decorated', desc: 'Earn 10 achievements' , xp: 30});
  return badges;
}

const RANKS = [
  { id: 'two',      label: '2',    minPoints: 15  },
  { id: 'three',    label: '3',    minPoints: 40  },
  { id: 'four',     label: '4',    minPoints: 70  },
  { id: 'five',     label: '5',    minPoints: 105 },
  { id: 'six',      label: '6',    minPoints: 145 },
  { id: 'seven',    label: '7',    minPoints: 190 },
  { id: 'eight',    label: '8',    minPoints: 240 },
  { id: 'nine',     label: '9',    minPoints: 295 },
  { id: 'ten',      label: '10',   minPoints: 355 },
  { id: 'eleven',   label: '11',   minPoints: 420 },
  { id: 'twelve',   label: '12',   minPoints: 490 },
  { id: 'thirteen', label: '13',   minPoints: 565 },
  { id: 'fourteen', label: '14',   minPoints: 645 },
  { id: 'one',      label: '1',    minPoints: 730 },
  { id: 'rook',     label: 'ROOK', minPoints: 820 },
];

function getPlayerRank(leaderboardPoints, achievementCount) {
  const score = (leaderboardPoints || 0); // XP now directly awarded per achievement
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
  if (!user) return null;
  if (!user.friends) user.friends = [];
  if (!user.pendingRequests) user.pendingRequests = [];
  return user;
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
  users.set(username.toLowerCase(), { id, username, password: hash, avatar: null, friends: [], pendingRequests: [] });
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

app.post('/auth/avatar', async (req, res) => {
  const user = getUserByToken((req.headers.authorization || '').replace('Bearer ', ''));
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { avatar } = req.body || {};
  if (!avatar || typeof avatar !== 'string') return res.status(400).json({ error: 'No avatar provided' });
  if (avatar.length > 200000) return res.status(400).json({ error: 'Image too large (max ~150KB)' });
  const fullUser = [...users.values()].find(u => u.id === user.id);
  if (fullUser) fullUser.avatar = avatar;
  saveDB();
  res.json({ ok: true });
});

app.post('/auth/validate', (req, res) => {
  const user = getUserByToken((req.body || {}).token);
  if (!user) return res.status(401).json({ error: 'Session expired.' });
  res.json({ ok: true, username: user.username, userId: user.id });
});

app.post('/stats', async (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.body||{}).token;
  const user = getUserByToken(token);
  if (!user) return res.status(401).json({ error: 'Invalid session.' });
  ensureStats(user.id);
  if (user.username?.toLowerCase() === 'admin') return res.json({ ok: true });
  const s = stats.get(user.id);
  const { bidMade, bidSet, lawedOff, tricksWon, pointsScored, won,
    cpuDifficulty, perfectBid, shutout, highBidMade, dominator, soloCarry, speedRun,
    bid150Made, bid160Made, oneHand, quickGame, rookTrickWin, cleanSweep, ghostWin,
    gamblerBid, nonBidderWin, clutchRook, bombSquad, comebackWin, hatTrick, bloodMoney,
    circusAct, slowBurn, pointMagnet, wildCard, tidalWave, onlineWin, perfectGame,
    warOfAttrition, fiveHundred, speedster, allIn } = req.body || {};
  const badgesBefore = new Set(getAchievements(s).map(a => a.id));
  s.gamesPlayed = (s.gamesPlayed || 0) + 1;
  if (won === true) s.gamesWon = (s.gamesWon || 0) + 1;
  if (bidMade) { s.bidsMade = (s.bidsMade||0)+1; s.consecutiveBidsMade = (s.consecutiveBidsMade||0)+1; }
  if (bidSet) { s.bidsSet = (s.bidsSet||0)+1; s.consecutiveBidsMade = 0; }
  if (lawedOff) s.lawedOff = (s.lawedOff||0)+1;
  s.tricksWon = (s.tricksWon||0) + (tricksWon||0);
  s.pointsScored = (s.pointsScored||0) + (pointsScored||0);
  if      (oneHand && cpuDifficulty === 'easy')   { s.cpuWinsEasy++;   if(won){s.oneHandWins=(s.oneHandWins||0)+1; s.leaderboardPoints=(s.leaderboardPoints||0)+10;} }
  else if (oneHand && cpuDifficulty === 'medium') { s.cpuWinsMedium++; if(won){s.oneHandWins=(s.oneHandWins||0)+1; s.leaderboardPoints=(s.leaderboardPoints||0)+20;} else{s.leaderboardPoints=(s.leaderboardPoints||0)+5;} }
  else if (oneHand && cpuDifficulty === 'hard')   { s.cpuWinsHard++;   if(won){s.oneHandWins=(s.oneHandWins||0)+1; s.leaderboardPoints=(s.leaderboardPoints||0)+35;} else{s.leaderboardPoints=(s.leaderboardPoints||0)+10;} }
  else if (oneHand && !cpuDifficulty)             { if(won){s.oneHandWins=(s.oneHandWins||0)+1; s.leaderboardPoints=(s.leaderboardPoints||0)+30;} else{s.leaderboardPoints=(s.leaderboardPoints||0)+10;} }
  else if (quickGame && cpuDifficulty === 'easy')   { s.cpuWinsEasy++;   s.quickWins=(s.quickWins||0)+(won?1:0); if(won){s.leaderboardPoints=(s.leaderboardPoints||0)+20;} else{s.leaderboardPoints=(s.leaderboardPoints||0)+5;} }
  else if (quickGame && cpuDifficulty === 'medium') { s.cpuWinsMedium++; s.quickWins=(s.quickWins||0)+(won?1:0); if(won){s.leaderboardPoints=(s.leaderboardPoints||0)+40;} else{s.leaderboardPoints=(s.leaderboardPoints||0)+10;} }
  else if (quickGame && cpuDifficulty === 'hard')   { s.cpuWinsHard++;   s.quickWins=(s.quickWins||0)+(won?1:0); if(won){s.leaderboardPoints=(s.leaderboardPoints||0)+65;} else{s.leaderboardPoints=(s.leaderboardPoints||0)+20;} }
  else if (quickGame && !cpuDifficulty)             { s.quickWins=(s.quickWins||0)+(won?1:0); if(won){s.leaderboardPoints=(s.leaderboardPoints||0)+75;} else{s.leaderboardPoints=(s.leaderboardPoints||0)+25;} }
  else if (cpuDifficulty === 'easy')   { s.cpuWinsEasy++;   s.classicWins=(s.classicWins||0)+(won?1:0); if(won){s.leaderboardPoints=(s.leaderboardPoints||0)+30;} else{s.leaderboardPoints=(s.leaderboardPoints||0)+5;} }
  else if (cpuDifficulty === 'medium') { s.cpuWinsMedium++; s.classicWins=(s.classicWins||0)+(won?1:0); if(won){s.leaderboardPoints=(s.leaderboardPoints||0)+75;} else{s.leaderboardPoints=(s.leaderboardPoints||0)+15;} }
  else if (cpuDifficulty === 'hard')   { s.cpuWinsHard++;   s.classicWins=(s.classicWins||0)+(won?1:0); if(won){s.leaderboardPoints=(s.leaderboardPoints||0)+120;} else{s.leaderboardPoints=(s.leaderboardPoints||0)+30;} }
  else if (!cpuDifficulty)             { s.classicWins=(s.classicWins||0)+(won?1:0); if(won){s.leaderboardPoints=(s.leaderboardPoints||0)+150;} else{s.leaderboardPoints=(s.leaderboardPoints||0)+50;} }
  if (perfectBid) s.perfectBids=(s.perfectBids||0)+1;
  if (shutout) s.shutouts=(s.shutouts||0)+1;
  if (highBidMade) s.highBidsMade=(s.highBidsMade||0)+1;
  if (bid150Made) s.bid150Made=(s.bid150Made||0)+1;
  if (bid160Made) s.bid160Made=(s.bid160Made||0)+1;
  if (dominator) s.dominatorWins=(s.dominatorWins||0)+1;
  if (soloCarry) s.soloCarryHands=(s.soloCarryHands||0)+1;
  if (speedRun) s.speedRunWins=(s.speedRunWins||0)+1;
  if (rookTrickWin) s.rookTrickWins=(s.rookTrickWins||0)+1;
  if (cleanSweep) s.cleanSweeps=(s.cleanSweeps||0)+1;
  if (ghostWin) s.ghostWins=(s.ghostWins||0)+1;
  if (gamblerBid) s.gamblerBids=(s.gamblerBids||0)+1;
  if (comebackWin) s.comebackWins=(s.comebackWins||0)+1;
  if (hatTrick) s.hatTrickWins=(s.hatTrickWins||0)+1;
  if (bloodMoney) s.bloodMoneyWins=(s.bloodMoneyWins||0)+1;
  if (circusAct) s.circusActWins=(s.circusActWins||0)+1;
  if (slowBurn) s.slowBurnWins=(s.slowBurnWins||0)+1;
  if (pointMagnet) s.pointMagnetWins=(s.pointMagnetWins||0)+1;
  if (wildCard) s.wildCardWins=(s.wildCardWins||0)+1;
  if (tidalWave) s.tidalWaveWins=(s.tidalWaveWins||0)+1;
  if (won===true) { s.currentStreak=(s.currentStreak||0)+1; s.bestStreak=Math.max(s.bestStreak||0,s.currentStreak); }
  else if (won===false) { s.currentStreak=0; }
  const badgesAfter = getAchievements(s);
  const newBadges = badgesAfter.filter(a => !badgesBefore.has(a.id));
  const xpEarned = (s.leaderboardPoints||0) - ((s.leaderboardPoints||0) - (newBadges.reduce((sum,b)=>sum+(b.xp||0),0)));
  saveDB();
  res.json({ ok: true, leaderboardPoints: s.leaderboardPoints, newBadges });
});

app.get('/leaderboard', (_, res) => {
  const rows = [...stats.entries()].map(([userId, s]) => {
    const u = [...users.values()].find(u => u.id === userId);
    if (!u || !s.gamesPlayed) return null;
    if (u.username.toLowerCase() === 'admin') return null;
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
      avatar: u.avatar || null,
      onlineGamesPlayed: s.onlineGamesPlayed || 0,
      onlineGamesWon: s.onlineGamesWon || 0,
      onlineWinPct: (s.onlineGamesPlayed||0) > 0 ? +((100 * (s.onlineGamesWon||0) / s.onlineGamesPlayed).toFixed(1)) : 0,
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

// ── Friends endpoints ────────────────────────────────────────────────────────
app.get('/friends', (req, res) => {
  const user = getUserByToken(req.headers.authorization?.replace('Bearer ', '') || '');
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const friends = user.friends.map(username => {
    const f = [...users.values()].find(u => u.username.toLowerCase() === username.toLowerCase());
    const fStats = f ? stats.get(f.id) : null;
    let rank = null;
    if (f && fStats) {
      const score = (fStats.leaderboardPoints||0) + (getAchievements(fStats).length)*10;
      for (const r of RANKS) { if (score >= r.minPoints) rank = r; }
    }
    return { username: f?.username || username, online: f ? onlineSockets.has(f.id) : false, avatar: f?.avatar || null, rank };
  });
  res.json({ friends, pendingRequests: user.pendingRequests || [] });
});

app.post('/friends/request', (req, res) => {
  const user = getUserByToken(req.headers.authorization?.replace('Bearer ', '') || '');
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { username } = req.body || {};
  const target = [...users.values()].find(u => u.username.toLowerCase() === username?.toLowerCase());
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === user.id) return res.status(400).json({ error: "Can't add yourself" });
  if (!target.pendingRequests) target.pendingRequests = [];
  if (!user.friends) user.friends = [];
  if (!target.friends) target.friends = [];
  if (user.friends.map(u => u.toLowerCase()).includes(target.username.toLowerCase())) return res.status(400).json({ error: 'Already friends' });
  if (target.pendingRequests.map(u => u.toLowerCase()).includes(user.username.toLowerCase())) return res.status(400).json({ error: 'Request already sent' });
  target.pendingRequests.push(user.username);
  saveDB();
  const targetSocketId = onlineSockets.get(target.id);
  if (targetSocketId) io.to(targetSocketId).emit('friend_request', { from: user.username });
  res.json({ ok: true });
});

app.post('/friends/respond', (req, res) => {
  const user = getUserByToken(req.headers.authorization?.replace('Bearer ', '') || '');
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { username, accept } = req.body || {};
  if (!user.pendingRequests) user.pendingRequests = [];
  user.pendingRequests = user.pendingRequests.filter(u => u.toLowerCase() !== username?.toLowerCase());
  if (accept) {
    if (!user.friends) user.friends = [];
    const requester = [...users.values()].find(u => u.username.toLowerCase() === username?.toLowerCase());
    if (requester) {
      if (!user.friends.map(u => u.toLowerCase()).includes(requester.username.toLowerCase())) user.friends.push(requester.username);
      if (!requester.friends) requester.friends = [];
      if (!requester.friends.map(u => u.toLowerCase()).includes(user.username.toLowerCase())) requester.friends.push(user.username);
      const rSocketId = onlineSockets.get(requester.id);
      if (rSocketId) io.to(rSocketId).emit('friend_accepted', { username: user.username });
    }
  }
  saveDB();
  res.json({ ok: true });
});

app.post('/friends/remove', (req, res) => {
  const user = getUserByToken(req.headers.authorization?.replace('Bearer ', '') || '');
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { username } = req.body || {};
  if (user.friends) user.friends = user.friends.filter(u => u.toLowerCase() !== username?.toLowerCase());
  const other = [...users.values()].find(u => u.username.toLowerCase() === username?.toLowerCase());
  if (other?.friends) other.friends = other.friends.filter(u => u.toLowerCase() !== user.username.toLowerCase());
  saveDB();
  res.json({ ok: true });
});

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
  return { code: room.code, host: room.hostUsername, players: room.players.map(p => ({ username: p.username, seat: p.seat, ready: p.ready, avatar: users.get(p.username?.toLowerCase())?.avatar || null })), started: room.started };
}

io.on('connection', socket => {
  socket.on('auth', ({ token }, cb) => {
    const user = getUserByToken(token);
    if (!user) return cb?.({ ok: false, error: 'Invalid session.' });
    socket.data.userId = user.id;
    socket.data.username = user.username;
    onlineSockets.set(user.id, socket.id);
    cb?.({ ok: true, username: user.username });
  });

  socket.on('invite_friend', ({ username, roomCode }, cb) => {
    if (!socket.data.userId) return cb?.({ ok: false });
    const target = [...users.values()].find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!target) return cb?.({ ok: false, error: 'User not found' });
    const targetSocketId = onlineSockets.get(target.id);
    if (!targetSocketId) return cb?.({ ok: false, error: 'User is offline' });
    io.to(targetSocketId).emit('game_invite', { from: socket.data.username, roomCode });
    cb?.({ ok: true });
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

  socket.on('start', ({ initialState, difficulty, gameLength }, cb) => {
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
    room.started = true; room.state = initialState; room.difficulty = difficulty || 'medium'; room.gameLength = gameLength || 500;
    const hostPlayer = room.players.find(p => p.id === socket.id);
    cb?.({ ok: true, seat: hostPlayer?.seat ?? 0 });
    io.to(room.code).emit('game_started', { state: initialState, players: room.players.map(p => ({ username: p.username, seat: p.seat, team: p.team ?? p.seat % 2, avatar: users.get(p.username?.toLowerCase())?.avatar || null })), difficulty: room.difficulty, gameLength: room.gameLength });
  });

  socket.on('action', ({ type, payload }) => {
    const room = rooms[socket.data.code];
    if (!room?.started) return;
    socket.to(room.code).emit('action', { type, payload, username: socket.data.username });
  });

  // Coordinated trick completion: host sends both states + delay, server timestamps and broadcasts to ALL
  socket.on('trick_sync', ({ intermediate, final: finalState, displayMs }) => {
    const room = rooms[socket.data.code];
    if (!room?.started || room.host !== socket.id) return;
    const serverTs = Date.now();
    io.to(room.code).emit('trick_sync', { intermediate, final: finalState, displayMs, serverTs });
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
    cpuDifficulty, perfectBid, shutout, highBidMade, dominator, soloCarry, speedRun, bid150Made, bid160Made, oneHand, quickGame,
    rookTrickWin, cleanSweep, ghostWin, gamblerBid, nonBidderWin, clutchRook, bombSquad, comebackWin,
    hatTrick, bloodMoney, circusAct, slowBurn, pointMagnet, wildCard, tidalWave, onlineWin, perfectGame,
    warOfAttrition, fiveHundred, speedster, allIn }) => {
    if (!socket.data.userId) return;
    ensureStats(socket.data.userId);
    if (socket.data.username?.toLowerCase() === 'admin') return;
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
        // XP: wins and losses both give XP, wins give more
    // One Hand
    if      (oneHand && cpuDifficulty === 'easy')   { s.cpuWinsEasy++;   if(won){s.oneHandWins=(s.oneHandWins||0)+1; s.leaderboardPoints=(s.leaderboardPoints||0)+10;} }
    else if (oneHand && cpuDifficulty === 'medium') { s.cpuWinsMedium++; if(won){s.oneHandWins=(s.oneHandWins||0)+1; s.leaderboardPoints=(s.leaderboardPoints||0)+20;} else{s.leaderboardPoints=(s.leaderboardPoints||0)+5;} }
    else if (oneHand && cpuDifficulty === 'hard')   { s.cpuWinsHard++;   if(won){s.oneHandWins=(s.oneHandWins||0)+1; s.leaderboardPoints=(s.leaderboardPoints||0)+35;} else{s.leaderboardPoints=(s.leaderboardPoints||0)+10;} }
    else if (oneHand && !cpuDifficulty)             { if(won){s.oneHandWins=(s.oneHandWins||0)+1; s.leaderboardPoints=(s.leaderboardPoints||0)+30;} else{s.leaderboardPoints=(s.leaderboardPoints||0)+10;} }
    // Quick Game
    else if (quickGame && cpuDifficulty === 'easy')   { s.cpuWinsEasy++;   s.quickWins=(s.quickWins||0)+(won?1:0); if(won){s.leaderboardPoints=(s.leaderboardPoints||0)+20;} else{s.leaderboardPoints=(s.leaderboardPoints||0)+5;} }
    else if (quickGame && cpuDifficulty === 'medium') { s.cpuWinsMedium++; s.quickWins=(s.quickWins||0)+(won?1:0); if(won){s.leaderboardPoints=(s.leaderboardPoints||0)+40;} else{s.leaderboardPoints=(s.leaderboardPoints||0)+10;} }
    else if (quickGame && cpuDifficulty === 'hard')   { s.cpuWinsHard++;   s.quickWins=(s.quickWins||0)+(won?1:0); if(won){s.leaderboardPoints=(s.leaderboardPoints||0)+65;} else{s.leaderboardPoints=(s.leaderboardPoints||0)+20;} }
    else if (quickGame && !cpuDifficulty)             { s.quickWins=(s.quickWins||0)+(won?1:0); if(won){s.leaderboardPoints=(s.leaderboardPoints||0)+75;} else{s.leaderboardPoints=(s.leaderboardPoints||0)+25;} }
    // Classic
    else if (cpuDifficulty === 'easy')   { s.cpuWinsEasy++;   s.classicWins=(s.classicWins||0)+(won?1:0); if(won){s.leaderboardPoints=(s.leaderboardPoints||0)+30;} else{s.leaderboardPoints=(s.leaderboardPoints||0)+5;} }
    else if (cpuDifficulty === 'medium') { s.cpuWinsMedium++; s.classicWins=(s.classicWins||0)+(won?1:0); if(won){s.leaderboardPoints=(s.leaderboardPoints||0)+75;} else{s.leaderboardPoints=(s.leaderboardPoints||0)+15;} }
    else if (cpuDifficulty === 'hard')   { s.cpuWinsHard++;   s.classicWins=(s.classicWins||0)+(won?1:0); if(won){s.leaderboardPoints=(s.leaderboardPoints||0)+120;} else{s.leaderboardPoints=(s.leaderboardPoints||0)+30;} }
    else if (!cpuDifficulty)             { s.classicWins=(s.classicWins||0)+(won?1:0); if(won){s.leaderboardPoints=(s.leaderboardPoints||0)+150;} else{s.leaderboardPoints=(s.leaderboardPoints||0)+50;} }
    // Special game feats
    if (perfectBid) s.perfectBids = (s.perfectBids || 0) + 1;
    if (shutout) s.shutouts = (s.shutouts || 0) + 1;
    if (highBidMade) s.highBidsMade = (s.highBidsMade || 0) + 1;
    if (bid150Made) s.bid150Made = (s.bid150Made || 0) + 1;
    if (bid160Made) s.bid160Made = (s.bid160Made || 0) + 1;
    if (dominator) s.dominatorWins = (s.dominatorWins || 0) + 1;
    if (soloCarry) s.soloCarryHands = (s.soloCarryHands || 0) + 1;
    if (speedRun) s.speedRunWins = (s.speedRunWins || 0) + 1;
    if (rookTrickWin) s.rookTrickWins = (s.rookTrickWins || 0) + 1;
    if (cleanSweep) s.cleanSweeps = (s.cleanSweeps || 0) + 1;
    if (ghostWin) s.ghostWins = (s.ghostWins || 0) + 1;
    if (gamblerBid) s.gamblerBids = (s.gamblerBids || 0) + 1;
    if (nonBidderWin) s.nonBidderWins = (s.nonBidderWins || 0) + 1;
    if (clutchRook) s.clutchRookWins = (s.clutchRookWins || 0) + 1;
    if (bombSquad) s.bombSquads = (s.bombSquads || 0) + 1;
    if (comebackWin) s.comebackWins = (s.comebackWins || 0) + 1;
    // New achievements
    if (hatTrick) s.hatTrickWins = (s.hatTrickWins||0) + 1;
    if (bloodMoney) s.bloodMoneyWins = (s.bloodMoneyWins||0) + 1;
    if (circusAct) s.circusActWins = (s.circusActWins||0) + 1;
    if (slowBurn) s.slowBurnWins = (s.slowBurnWins||0) + 1;
    if (pointMagnet) s.pointMagnetWins = (s.pointMagnetWins||0) + 1;
    if (wildCard) s.wildCardWins = (s.wildCardWins||0) + 1;
    if (tidalWave) s.tidalWaveWins = (s.tidalWaveWins||0) + 1;
    if (onlineWin) s.rookieOnlineWins = (s.rookieOnlineWins||0) + 1;
    if (perfectGame) s.perfectGames = (s.perfectGames||0) + 1;
    // Batch 3 achievements
    if (eruption) s.eruptionWins = (s.eruptionWins||0) + 1;
    if (duelistWin) s.duelistWins = (s.duelistWins||0) + 1;
    if (fullHouse) s.fullHouseWins = (s.fullHouseWins||0) + 1;
    if (magician) s.magicianWins = (s.magicianWins||0) + 1;
    if (doubleAgent) s.doubleAgentWins = (s.doubleAgentWins||0) + 1;
    if (snake) s.snakeWins = (s.snakeWins||0) + 1;
    if (pirate) s.pirateWins = (s.pirateWins||0) + 1;
    if (comebackBig) s.comebackBigWins = (s.comebackBigWins||0) + 1;
    if (galaxyBrain) s.galaxyBrainWins = (s.galaxyBrainWins||0) + 1;
    // Online play tracking
    if (!cpuDifficulty) s.onlineGamesPlayed = (s.onlineGamesPlayed||0) + 1;
    if (won === true && !cpuDifficulty) s.onlineGamesWon = (s.onlineGamesWon||0) + 1;
    // Mode-specific wins
    if (won === true && !oneHand && !quickGame) s.classicWins = (s.classicWins||0) + 1;
    if (won === true && quickGame) s.quickWins = (s.quickWins||0) + 1;
    if (won === true && oneHand) s.oneHandWins = (s.oneHandWins||0) + 1;
    if (warOfAttrition) s.warOfAttritionWins = (s.warOfAttritionWins||0) + 1;
    if (fiveHundred) s.fiveHundredWins = (s.fiveHundredWins||0) + 1;
    if (speedster) s.speedsterWins = (s.speedsterWins||0) + 1;
    if (allIn) s.allInWins = (s.allInWins||0) + 1;
    // Cold blooded streak
    if (won === true && !bidSet) { s.coldBloodedStreak = (s.coldBloodedStreak||0) + 1; if (s.coldBloodedStreak >= 10) s.coldBloodedWins = (s.coldBloodedWins||0) + 1; }
    else if (bidSet) { s.coldBloodedStreak = 0; }
    // Fox: quick game streak
    if (won === true && quickGame) { s.quickGameStreak = (s.quickGameStreak||0) + 1; if (s.quickGameStreak >= 3) s.foxWins = (s.foxWins||0) + 1; }
    else if (!quickGame) { s.quickGameStreak = 0; }
    // Boom: session wins
    if (won === true) { s.sessionWins = (s.sessionWins||0) + 1; if (s.sessionWins >= 5) s.boomWins = (s.boomWins||0) + 1; }
    // Stone Wall: consecutive games not set
    if (bidSet) { s.consecutiveGamesNotSet = 0; }
    else if (won) { s.consecutiveGamesNotSet = (s.consecutiveGamesNotSet||0) + 1; if (s.consecutiveGamesNotSet >= 3) s.stoneWallGames = (s.stoneWallGames||0) + 1; }
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
    // King of the Table: check if user is #1
    const allRankScores = [...stats.entries()].map(([uid, st]) => ({ uid, score: st.leaderboardPoints||0 })).sort((a,b) => b.score - a.score);
    if (allRankScores[0]?.uid === socket.data.userId) { s.kingOfTable = true; } else { s.kingOfTable = false; }
    // Award XP for newly unlocked achievements
    if (newlyUnlocked.length > 0) {
      const bonusXP = newlyUnlocked.reduce((sum, a) => sum + (a.xp || 10), 0);
      s.leaderboardPoints = (s.leaderboardPoints || 0) + bonusXP;
    }
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

  socket.on('leave_room', () => {
    const { code, username } = socket.data;
    const room = rooms[code];
    if (!room) return;
    room.players = room.players.filter(p => p.id !== socket.id);
    socket.data.code = null;
    socket.leave(code);
    if (room.players.length === 0) { delete rooms[code]; return; }
    if (room.started) { io.to(code).emit('game_abandoned', { username }); delete rooms[code]; return; }
    if (room.host === socket.id) room.host = room.players[0].id;
    io.to(code).emit('player_left', { username, room: roomSummary(room) });
  });

  socket.on('disconnect', () => {
    if (socket.data.userId) onlineSockets.delete(socket.data.userId);
    const { code, username } = socket.data;
    const room = rooms[code];
    if (!room) return;
    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.players.length === 0 || room.started) {
      // Kill started games immediately when anyone leaves — no rejoining mid-game
      io.to(code).emit('game_abandoned', { username });
      delete rooms[code];
      return;
    }
    if (room.host === socket.id) room.host = room.players[0].id;
    io.to(code).emit('player_left', { username, room: roomSummary(room) });
  });
});


// Auto-cleanup stale rooms every 60 seconds
setInterval(() => {
  Object.keys(rooms).forEach(code => {
    const room = rooms[code];
    if (room.players.length === 0) { delete rooms[code]; return; }
    // Kill started games with only 1 player left
    if (room.started && room.players.length < 2) {
      io.to(code).emit('game_abandoned', { username: null });
      delete rooms[code];
    }
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
// deploy trigger Thu Aug  6 19:53:41 EDT 2026
