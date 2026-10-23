const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite');

const games = new Map(), clients = new Map(), publicDir = path.join(__dirname, 'public'), dataDir = path.join(__dirname, 'data');
const configuredDbPath = process.env.CLOUD_PUZZLE_DB;
const dbPath = configuredDbPath ? (path.isAbsolute(configuredDbPath) ? configuredDbPath : path.resolve(__dirname, configuredDbPath)) : path.join(dataDir, 'cloud-puzzle.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON');
try { db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;'); } catch {}
db.exec(`CREATE TABLE IF NOT EXISTS games (
  code TEXT PRIMARY KEY,
  image TEXT NOT NULL,
  size INTEGER NOT NULL,
  player_count INTEGER NOT NULL,
  board_json TEXT NOT NULL,
  tiles_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS players (
  game_code TEXT NOT NULL REFERENCES games(code) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  owner INTEGER NOT NULL,
  PRIMARY KEY (game_code, id),
  UNIQUE (game_code, owner)
);`);
function id() { return crypto.randomBytes(5).toString('hex'); }
function json(res, code, value) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
function ownership(players, columns = 9) {
  const base = Math.floor(columns / players), extra = columns % players, owner = [];
  for (let p = 0, col = 0; p < players; p++) for (let n = 0; n < base + (p < extra ? 1 : 0); n++) owner[col++] = p;
  return owner;
}
function makeTiles(playerCount, size = 9) {
  const owners = ownership(playerCount, size), tiles = [];
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) tiles.push({ id: row + '-' + col, row, col, owner: owners[col] });
  return tiles;
}
const PREPLACED_RATIO = 0.2; // share of each player's tiles that start in the right place (early win, lower stress)
function shuffleInPlace(a) { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function derange(a) { // Sattolo: one big cycle, so no element stays put
  for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function scramble(tiles, size = Math.sqrt(tiles.length)) {
  const board = tiles.map(t => t.id);
  const ownerCount = Math.max(...tiles.map(t => t.owner)) + 1, owners = ownership(ownerCount, size);
  for (let owner = 0; owner < ownerCount; owner++) {
    const positions = [];
    for (let i = 0; i < board.length; i++) if (owners[i % size] === owner) positions.push(i);
    if (positions.length < 2) continue;
    const keep = Math.min(Math.floor(positions.length * PREPLACED_RATIO), positions.length - 2);
    const moving = shuffleInPlace(positions.slice()).slice(keep);   // positions that will be scrambled
    const tilesHere = derange(moving.map(p => board[p]));
    moving.forEach((p, i) => { board[p] = tilesHere[i]; });
  }
  return board;
}
function swap(board, tiles, playerCount, playerOwner, from, to, size = Math.sqrt(board.length)) {
  const owners = ownership(playerCount, size), byId = new Map(tiles.map(t => [t.id, t])), a = byId.get(board[from]), b = byId.get(board[to]), total = size * size;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= total || to < 0 || to >= total || from === to || owners[from % size] !== playerOwner || owners[to % size] !== playerOwner || !a || !b || a.owner !== playerOwner || b.owner !== playerOwner) return false;
  [board[from], board[to]] = [board[to], board[from]]; return true;
}
function progress(board, tiles, owner, size = Math.sqrt(board.length)) {
  const byId = new Map(tiles.map(t => [t.id, t]));
  return board.reduce((count, tileId, position) => { const tile = byId.get(tileId); return count + (tile && tile.owner === owner && tile.row === Math.floor(position / size) && tile.col === position % size ? 1 : 0); }, 0);
}
// Optimal number of swaps needed = misplaced tiles - number of cycles of the permutation.
function minSwaps(board, owner, size, tiles) {
  const where = new Map(); board.forEach((id, pos) => where.set(id, pos));
  const mine = []; for (let p = 0; p < board.length; p++) if (tiles[p].owner === owner) mine.push(p);
  const seen = new Set(); let swaps = 0;
  for (const p of mine) {
    if (seen.has(p)) continue;
    let len = 0, cur = p;
    while (!seen.has(cur)) { seen.add(cur); cur = where.get(tiles[cur].id); len++; }
    swaps += len - 1;
  }
  return swaps;
}
function complete(game) {
  const byId = new Map(game.tiles.map(t => [t.id, t]));
  return game.board.every((tileId, position) => { const tile = byId.get(tileId); return tile && tile.row === Math.floor(position / game.size) && tile.col === position % game.size; });
}
let moveStmt;
function persistMove(game) {
  moveStmt = moveStmt || db.prepare('UPDATE games SET board_json = ?, done = ? WHERE code = ?');
  moveStmt.run(JSON.stringify(game.board), game.done ? 1 : 0, game.code);
}
function persistGame(game) {
  const gameStatement = db.prepare(`INSERT INTO games (code, image, size, player_count, board_json, tiles_json, created_at, done)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET image=excluded.image, size=excluded.size, player_count=excluded.player_count,
      board_json=excluded.board_json, tiles_json=excluded.tiles_json, done=excluded.done`);
  const deletePlayers = db.prepare('DELETE FROM players WHERE game_code = ?');
  const playerStatement = db.prepare('INSERT INTO players (game_code, id, name, owner) VALUES (?, ?, ?, ?)');
  db.exec('BEGIN IMMEDIATE');
  try {
    gameStatement.run(game.code, game.image, game.size, game.playerCount, JSON.stringify(game.board), JSON.stringify(game.tiles), game.createdAt, game.done ? 1 : 0);
    deletePlayers.run(game.code);
    for (const player of game.players) playerStatement.run(game.code, player.id, player.name, player.owner);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
function loadGames() {
  const rows = db.prepare('SELECT * FROM games ORDER BY created_at').all();
  const players = db.prepare('SELECT game_code, id, name, owner FROM players ORDER BY owner').all();
  for (const row of rows) {
    try {
      const game = { code: row.code, image: row.image, size: row.size, playerCount: row.player_count, board: JSON.parse(row.board_json), tiles: JSON.parse(row.tiles_json), createdAt: row.created_at, lastActiveAt: Date.now(), players: players.filter(player => player.game_code === row.code).map(({ game_code, ...player }) => player), done: Boolean(row.done) };
      if (game.board.length === game.size * game.size && game.tiles.length === game.size * game.size) games.set(game.code, game);
    } catch (error) {
      throw new Error('Failed to restore persisted room ' + row.code + ': ' + error.message);
    }
  }
}
const IDLE_MINUTES = Number(process.env.ROOM_IDLE_MINUTES) || 120;
const IDLE_TIMEOUT_MS = IDLE_MINUTES * 60 * 1000;
function deleteGame(code) {
  const game = games.get(code);
  if (!game) return;
  const list = clients.get(code) || [];
  for (const client of list) {
    try {
      client.write('data: ' + JSON.stringify({ expired: true, message: 'Room closed after ' + IDLE_MINUTES + ' minutes of inactivity.' }) + '\n\n');
      client.end();
    } catch {}
  }
  clients.delete(code);
  games.delete(code);
  try { db.prepare('DELETE FROM games WHERE code = ?').run(code); } catch {}
}
setInterval(() => {
  const now = Date.now();
  for (const [code, game] of games.entries()) {
    if ((clients.get(code) || []).length) game.lastActiveAt = now; // someone is connected: room is alive
    if (now - (game.lastActiveAt || 0) > IDLE_TIMEOUT_MS) {
      deleteGame(code);
    }
  }
}, 15000).unref();
setInterval(() => { for (const list of clients.values()) for (const res of list) { try { res.write(': ping\n\n'); } catch {} } }, 20000).unref();
function closePersistence() { db.close(); }
function publicGame(game, { includeImage = true, includeTiles = true } = {}) {
  const base = { code: game.code, size: game.size, playerCount: game.playerCount, board: game.board, players: game.players.map(p => ({ id: p.id, name: p.name, owner: p.owner, total: game.tiles.filter(t => t.owner === p.owner).length, correct: progress(game.board, game.tiles, p.owner, game.size) })), done: complete(game) };
  if (includeTiles) base.tiles = game.tiles;
  if (includeImage) base.image = game.image;
  return base;
}
// SSE broadcasts omit the image (it never changes and can be 1–3 MB per message).
function broadcast(game) { const message = 'data: ' + JSON.stringify(publicGame(game, { includeImage: false, includeTiles: false })) + '\n\n'; for (const res of (clients.get(game.code) || [])) { try { res.write(message); } catch {} } }
function body(req) { return new Promise((resolve, reject) => { let data = ''; req.on('data', chunk => { data += chunk; if (data.length > 16 * 1024 * 1024) { req.destroy(); reject(Error('Request too large.')); } }); req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } }); }); }
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const fileCache = new Map();
function sendFile(req, res, file) {
  let st; try { st = fs.statSync(file); } catch { return json(res, 404, { error: 'Not found' }); }
  if (!st.isFile()) return json(res, 404, { error: 'Not found' });
  const etag = '"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
  const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', ETag: etag, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  let entry = fileCache.get(file);
  if (!entry || entry.etag !== etag) { const raw = fs.readFileSync(file); entry = { etag, raw, gz: zlib.gzipSync(raw, { level: 9 }) }; fileCache.set(file, entry); }
  const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  if (gzip) headers['Content-Encoding'] = 'gzip';
  res.writeHead(200, headers); res.end(gzip ? entry.gz : entry.raw);
}
function imageOf(game) {
  if (!game.imageBuf) { const m = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/s.exec(game.image); game.imageBuf = m ? { type: m[1], data: Buffer.from(m[2], 'base64') } : null; }
  return game.imageBuf;
}
loadGames();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://' + req.headers.host), parts = url.pathname.split('/').filter(Boolean);
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { status: 'ok', uptime: Math.floor(process.uptime()), rooms: games.size });
    if (req.method === 'GET' && url.pathname === '/') return sendFile(req, res, path.join(publicDir, 'index.html'));
    if (req.method === 'GET' && url.pathname.startsWith('/')) { const file = path.join(publicDir, path.basename(url.pathname)); if (fs.existsSync(file)) return sendFile(req, res, file); }
    if (req.method === 'POST' && url.pathname === '/api/games') {
      const data = await body(req), count = Number(data.players) || 2, size = Number(data.size) || 9;
      const image = String(data.image || '');
      if (image.length > 12 * 1024 * 1024) return json(res, 400, { error: 'The image is too large.' });
      if (!/^data:image\/[a-z0-9.+-]+;base64,/.test(image)) return json(res, 400, { error: 'The image format is invalid.' });
      if (![5, 6, 9].includes(size) || count < 2 || count > size || !String(data.image || '').startsWith('data:image/')) return json(res, 400, { error: 'Choose a 5×5, 6×6, or 9×9 game with no more players than columns.' });
      const code = id().toUpperCase(), tiles = makeTiles(count, size), game = { code, image, size, playerCount: count, tiles, board: scramble(tiles, size), players: [], createdAt: new Date().toISOString(), lastActiveAt: Date.now(), done: false };
      try { persistGame(game); } catch { return json(res, 500, { error: 'The game could not be saved.' }); }
      games.set(code, game); return json(res, 201, { code });
    }
    if (parts[0] !== 'api' || parts[1] !== 'games' || !games.has(parts[2])) return json(res, 404, { error: 'Not found' });
    const game = games.get(parts[2]);
    game.lastActiveAt = Date.now();
    if (req.method === 'GET' && parts[3] === 'image') {
      const img = imageOf(game); if (!img) return json(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': img.type, 'Content-Length': img.data.length, 'Cache-Control': 'private, max-age=31536000, immutable' }); return res.end(img.data);
    }
    if (req.method === 'GET' && parts[3] === 'events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n');
      const list = clients.get(game.code) || []; list.push(res); clients.set(game.code, list); res.write('data: ' + JSON.stringify(publicGame(game, { includeImage: url.searchParams.get('lite') !== '1' })) + '\n\n');
      req.on('close', () => clients.set(game.code, (clients.get(game.code) || []).filter(x => x !== res))); return;
    }
    if (req.method === 'POST' && parts[3] === 'join') {
      const data = await body(req); if (typeof data.id !== 'string' || !data.id || data.id.length > 64) delete data.id;
      const lite = data.lite === true, existing = game.players.find(p => p.id === data.id);
      if (existing) return json(res, 200, { player: existing, game: publicGame(game, { includeImage: !lite }) });
      if (game.players.length >= game.playerCount) return json(res, 400, { error: 'Game is full.' });
      const player = { id: data.id || id(), name: String(data.name || 'Player ' + (game.players.length + 1)).slice(0, 24), owner: game.players.length };
      game.players.push(player);
      try { persistGame(game); } catch { game.players.pop(); return json(res, 500, { error: 'The player could not be saved.' }); }
      broadcast(game); return json(res, 201, { player, game: publicGame(game, { includeImage: !lite }) });
    }
    if (req.method === 'POST' && parts[3] === 'swap') {
      const data = await body(req), player = game.players.find(p => p.id === data.playerId);
      const from = Number(data.from), to = Number(data.to);
      if (!player || !swap(game.board, game.tiles, game.playerCount, player.owner, from, to, game.size)) return json(res, 400, { error: 'Choose two positions inside your region.' });
      game.done = complete(game);
      try { persistMove(game); } catch { [game.board[from], game.board[to]] = [game.board[to], game.board[from]]; game.done = complete(game); return json(res, 500, { error: 'The move could not be saved.' }); }
      broadcast(game); return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && parts[3] === 'solve') {
      if (process.env.NODE_ENV === 'production' && process.env.ENABLE_SOLVE !== '1') return json(res, 403, { error: 'Solve is disabled.' });
      game.board = game.tiles.map(t => t.id);
      game.done = true;
      try { persistMove(game); } catch { return json(res, 500, { error: 'The solve could not be saved.' }); }
      broadcast(game); return json(res, 200, { ok: true });
    }
    json(res, 405, { error: 'Method not allowed' });
  } catch (e) { json(res, 400, { error: 'Bad request' }); }
});
if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  console.log('SQLite database: ' + dbPath);
  console.log('Restored rooms: ' + games.size);
  server.listen(port, '0.0.0.0', () => console.log('Puzzle running on http://0.0.0.0:' + port));

  function shutdown(signal) {
    console.log(`Received ${signal}, closing server...`);
    server.close(() => {
      try {
        closePersistence();
        console.log('SQLite database closed cleanly.');
      } catch (err) {
        console.error('Error closing SQLite:', err);
      }
      process.exit(0);
    });
    setTimeout(() => {
      console.error('Forced shutdown due to timeout.');
      process.exit(1);
    }, 5000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
module.exports = { minSwaps, ownership, makeTiles, scramble, swap, progress, persistGame, loadGames, closePersistence, deleteGame, games, server };
