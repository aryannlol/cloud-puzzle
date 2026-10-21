const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-puzzle-'));
process.env.CLOUD_PUZZLE_DB = path.join(testDir, 'test.sqlite');
const { ownership, makeTiles, scramble, swap, progress, closePersistence } = require('./server');

for (const size of [5, 6, 9]) {
  const owners = ownership(2, size), tiles = makeTiles(2, size), board = scramble(tiles, size), byId = new Map(tiles.map(t => [t.id, t]));
  assert.equal(tiles.length, size * size);
  assert.equal(new Set(board).size, size * size);
  board.forEach((id, position) => assert.equal(byId.get(id).owner, owners[position % size]));
  assert.equal(owners.filter(x => x === 0).length * size, Math.ceil(size / 2) * size);
  assert.equal(owners.filter(x => x === 1).length * size, Math.floor(size / 2) * size);
  assert.equal(swap(board, tiles, 2, 0, 0, size, size), true);
  assert.equal(swap(board, tiles, 2, 0, size - 1, size, size), false);
  assert.equal(swap(board, tiles, 2, 1, 0, size, size), false);
  assert.equal(progress(tiles.map(t => t.id), tiles, 0, size), Math.ceil(size / 2) * size);
}
assert.equal(0 / 8 * 100, 0);
assert.equal(8 / 8 * 100, 100);

function startServer(port) {
  const child = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, CLOUD_PUZZLE_DB: path.join(testDir, 'test.sqlite'), PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let output = '';
    const onData = chunk => { output += chunk; if (output.includes('Puzzle running')) { child.startupOutput = output; child.stdout.off('data', onData); resolve(child); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', chunk => output += chunk);
    child.once('error', reject);
    setTimeout(() => reject(Error('Timed out starting test server: ' + output)), 5000).unref();
  });
}
async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise(resolve => child.once('exit', resolve));
}
async function firstEvent(response) {
  const reader = response.body.getReader();
  const { value } = await reader.read();
  reader.cancel();
  return JSON.parse(new TextDecoder().decode(value).match(/data: (.+)\n/)[1]);
}
async function persistenceChecks() {
  const port = 35127, image = 'data:image/png;base64,AA==';
  let child = await startServer(port);
  const base = 'http://127.0.0.1:' + port;
  try {
    const health = await fetch(base + '/health');
    assert.equal(health.status, 200);
    const healthData = await health.json();
    assert.equal(healthData.status, 'ok');
    const create = await fetch(base + '/api/games', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ players: 2, size: 5, image }) });
    assert.equal(create.status, 201);
    const { code } = await create.json();
    const join = await fetch(base + '/api/games/' + code + '/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'test-player-1', name: 'Tester' }) });
    assert.equal(join.status, 201);
    const joined = await join.json();
    const join2 = await fetch(base + '/api/games/' + code + '/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'test-player-2', name: 'Tester 2' }) });
    assert.equal(join2.status, 201);
    const before = joined.game.board.slice();
    const valid = await fetch(base + '/api/games/' + code + '/swap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ playerId: 'test-player-1', from: 0, to: 1 }) });
    assert.equal(valid.status, 200);
    const validState = await firstEvent(await fetch(base + '/api/games/' + code + '/events'));
    const invalid = await fetch(base + '/api/games/' + code + '/swap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ playerId: 'test-player-1', from: 0, to: 4 }) });
    assert.equal(invalid.status, 400);
    const saved = await firstEvent(await fetch(base + '/api/games/' + code + '/events'));
    assert.deepEqual(saved.board, validState.board);
    const concurrent = await Promise.all([
      fetch(base + '/api/games/' + code + '/swap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ playerId: 'test-player-1', from: 0, to: 1 }) }),
      fetch(base + '/api/games/' + code + '/swap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ playerId: 'test-player-1', from: 5, to: 6 }) })
    ]);
    assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 200]);
    const concurrentState = await firstEvent(await fetch(base + '/api/games/' + code + '/events'));
    assert.equal(new Set(concurrentState.board).size, 25);
    assert.notDeepEqual(saved.board, before);
    const savedBoard = concurrentState.board.slice();
    await stopServer(child); child = await startServer(port);
    assert.match(child.startupOutput, /SQLite database: .*test\.sqlite/);
    assert.equal(fs.existsSync(path.join(testDir, 'test.sqlite')), true);
    assert.ok(fs.statSync(path.join(testDir, 'test.sqlite')).size > 0);
    const restoredResponse = await fetch(base + '/api/games/' + code + '/events');
    const restored = await firstEvent(restoredResponse);
    assert.deepEqual(restored.board, savedBoard);
    assert.equal(restored.image, image);
    assert.equal(restored.players[0].id, 'test-player-1');
    assert.equal(restored.players[1].id, 'test-player-2');
    assert.equal(new Set(restored.board).size, 25);
    const resume1 = await fetch(base + '/api/games/' + code + '/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'test-player-1', name: 'Tester' }) });
    const resume2 = await fetch(base + '/api/games/' + code + '/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'test-player-2', name: 'Tester 2' }) });
    assert.equal(resume1.status, 200);
    assert.equal(resume2.status, 200);
    assert.deepEqual((await resume1.json()).game.board, restored.board);
    assert.deepEqual((await resume2.json()).game.board, restored.board);
    console.log('SQLite test database: ' + path.resolve(testDir, 'test.sqlite'));
  } finally {
    await stopServer(child);
    closePersistence();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}
persistenceChecks().then(() => console.log('5x5, 6x6, 9x9 ownership plus SQLite persistence and restart checks passed')).catch(error => { console.error(error); process.exitCode = 1; });
