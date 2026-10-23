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
    const solveRes = await fetch(base + '/api/games/' + code + '/solve', { method: 'POST' });
    assert.equal(solveRes.status, 200);
    const solvedEvent = await firstEvent(await fetch(base + '/api/games/' + code + '/events'));
    assert.equal(solvedEvent.done, true);
    await multiplayerRegressionTests(base);
    console.log('SQLite test database: ' + path.resolve(testDir, 'test.sqlite'));
  } finally {
    await stopServer(child);
    closePersistence();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

async function multiplayerRegressionTests(base) {
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  // 1. Create a room with two players using separate client sessions.
  const createRes = await fetch(base + '/api/games', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ players: 2, size: 5, image }) });
  assert.equal(createRes.status, 201);
  const { code } = await createRes.json();

  const session1Id = 'session-1-' + Date.now();
  const session2Id = 'session-2-' + Date.now();

  const join1 = await fetch(base + '/api/games/' + code + '/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: session1Id, name: 'Alice', lite: true }) });
  assert.equal(join1.status, 201);
  const res1 = await join1.json();

  const join2 = await fetch(base + '/api/games/' + code + '/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: session2Id, name: 'Bob', lite: true }) });
  assert.equal(join2.status, 201);
  const res2 = await join2.json();

  // 2. Assert that the two sessions receive different player IDs.
  assert.notEqual(res1.player.id, res2.player.id);
  assert.equal(res1.player.id, session1Id);
  assert.equal(res2.player.id, session2Id);

  // 3. Assert that each session maps to the correct owner and region.
  assert.equal(res1.player.owner, 0);
  assert.equal(res2.player.owner, 1);
  assert.equal(res1.game.players[0].total, 15);
  assert.equal(res2.game.players[1].total, 10);

  // 4. Assert that both clients receive identical authoritative board arrays.
  assert.deepEqual(res1.game.board, res2.game.board);
  assert.equal(res1.game.board.length, 25);

  // 5. Verify that both clients receive the same board after a valid swap.
  const swapRes = await fetch(base + '/api/games/' + code + '/swap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ playerId: session1Id, from: 0, to: 1 }) });
  assert.equal(swapRes.status, 200);
  const sseAfterSwap = await firstEvent(await fetch(base + '/api/games/' + code + '/events'));
  const rejoin1 = await (await fetch(base + '/api/games/' + code + '/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: session1Id, lite: true }) })).json();
  const rejoin2 = await (await fetch(base + '/api/games/' + code + '/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: session2Id, lite: true }) })).json();
  assert.deepEqual(sseAfterSwap.board, rejoin1.game.board);
  assert.deepEqual(rejoin1.game.board, rejoin2.game.board);

  // 6. Verify that a client cannot swap tiles outside its ownership.
  const invalidSwap = await fetch(base + '/api/games/' + code + '/swap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ playerId: session1Id, from: 0, to: 3 }) });
  assert.equal(invalidSwap.status, 400);
  const invalidSwap2 = await fetch(base + '/api/games/' + code + '/swap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ playerId: session2Id, from: 3, to: 0 }) });
  assert.equal(invalidSwap2.status, 400);

  // 7. Verify that reconnecting a player preserves identity.
  const reconnectP1 = await fetch(base + '/api/games/' + code + '/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: session1Id, lite: true }) });
  assert.equal(reconnectP1.status, 200);
  const rec1 = await reconnectP1.json();
  assert.equal(rec1.player.id, session1Id);
  assert.equal(rec1.player.owner, 0);

  const reconnectP2 = await fetch(base + '/api/games/' + code + '/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: session2Id, lite: true }) });
  assert.equal(reconnectP2.status, 200);
  const rec2 = await reconnectP2.json();
  assert.equal(rec2.player.id, session2Id);
  assert.equal(rec2.player.owner, 1);

  // 8. Verify that a third and fourth player are assigned correctly.
  const create4 = await fetch(base + '/api/games', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ players: 4, size: 6, image }) });
  assert.equal(create4.status, 201);
  const code4 = (await create4.json()).code;
  const p1_4 = await (await fetch(base + '/api/games/' + code4 + '/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'p1-4', name: 'P1', lite: true }) })).json();
  const p2_4 = await (await fetch(base + '/api/games/' + code4 + '/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'p2-4', name: 'P2', lite: true }) })).json();
  const p3_4 = await (await fetch(base + '/api/games/' + code4 + '/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'p3-4', name: 'P3', lite: true }) })).json();
  const p4_4 = await (await fetch(base + '/api/games/' + code4 + '/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'p4-4', name: 'P4', lite: true }) })).json();

  assert.equal(p1_4.player.owner, 0);
  assert.equal(p2_4.player.owner, 1);
  assert.equal(p3_4.player.owner, 2);
  assert.equal(p4_4.player.owner, 3);
  assert.equal(new Set([p1_4.player.id, p2_4.player.id, p3_4.player.id, p4_4.player.id]).size, 4);

  // 9. Verify that browser layout changes / client side queries do not mutate game state.
  const boardBeforeQuery = p4_4.game.board.slice();
  await fetch(base + '/api/games/' + code4 + '/image');
  await fetch(base + '/api/games/' + code4 + '/events');
  const boardAfterQuery = (await (await fetch(base + '/api/games/' + code4 + '/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'p1-4', lite: true }) })).json()).game.board;
  assert.deepEqual(boardBeforeQuery, boardAfterQuery);
  await autoSolveAndEdgeCaseTests(base);
}

function themeLogicUnitTests() {
  function getEffectiveTheme(preference, systemDark) {
    if (preference === 'light' || preference === 'dark') return preference;
    return systemDark ? 'dark' : 'light';
  }

  assert.equal(getEffectiveTheme('system', true), 'dark');
  assert.equal(getEffectiveTheme('system', false), 'light');
  assert.equal(getEffectiveTheme('light', true), 'light');
  assert.equal(getEffectiveTheme('light', false), 'light');
  assert.equal(getEffectiveTheme('dark', false), 'dark');
  assert.equal(getEffectiveTheme('dark', true), 'dark');

  function getStoredTheme(mockStorage) {
    try {
      const val = mockStorage.getItem('cloudPuzzleTheme');
      if (val === 'light' || val === 'dark' || val === 'system') return val;
    } catch {}
    return 'system';
  }

  assert.equal(getStoredTheme({ getItem: () => null }), 'system');
  assert.equal(getStoredTheme({ getItem: () => 'invalid-theme' }), 'system');
  assert.equal(getStoredTheme({ getItem: () => 'dark' }), 'dark');
  assert.equal(getStoredTheme({ getItem: () => 'light' }), 'light');
  assert.equal(getStoredTheme({ getItem: () => 'system' }), 'system');
  assert.equal(getStoredTheme({ getItem: () => { throw new Error('QuotaExceeded / SecurityError'); } }), 'system');
}

async function autoSolveAndEdgeCaseTests(base) {
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  const create = await (await fetch(base + '/api/games', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ players: 2, size: 5, image }) })).json();
  const code = create.code;

  const longName1 = 'Alice With An Extremely Long Name That Could Cause Overflow '.repeat(2).trim();
  const join1 = await (await fetch(base + '/api/games/' + code + '/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'p1-autosolve', name: longName1, lite: true }) })).json();
  const join2 = await (await fetch(base + '/api/games/' + code + '/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'p2-other', name: 'Bob', lite: true }) })).json();

  assert.equal(join1.player.name, longName1.slice(0, 24));
  assert.equal(join1.player.owner, 0);
  assert.equal(join2.player.owner, 1);

  function inPlayerRegion(pos, owner, size, count) {
    const baseCols = Math.floor(size / count);
    const extra = size % count;
    const start = owner * baseCols + Math.min(owner, extra);
    const end = start + baseCols + (owner < extra ? 1 : 0);
    const col = pos % size;
    return col >= start && col < end;
  }

  let currentBoard = join1.game.board.slice();

  function findHint(board, size, owner, count) {
    const baseCols = Math.floor(size / count);
    const extra = size % count;
    const start = owner * baseCols + Math.min(owner, extra);
    const end = start + baseCols + (owner < extra ? 1 : 0);
    const want = p => Math.floor(p / size) + '-' + (p % size);
    for (let row = 0; row < size; row++) {
      for (let col = start; col < end; col++) {
        const p = row * size + col;
        if (board[p] === want(p)) continue;
        const q = board.indexOf(want(p));
        return [p, q];
      }
    }
    return null;
  }

  let steps = 0;
  while (steps < 20) {
    const hint = findHint(currentBoard, 5, 0, 2);
    if (!hint) break;
    assert.equal(inPlayerRegion(hint[0], 0, 5, 2), true);
    assert.equal(inPlayerRegion(hint[1], 0, 5, 2), true);

    const swapRes = await fetch(base + '/api/games/' + code + '/swap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: 'p1-autosolve', from: hint[0], to: hint[1] })
    });
    assert.equal(swapRes.status, 200);
    const sse = await firstEvent(await fetch(base + '/api/games/' + code + '/events'));
    currentBoard = sse.board.slice();
    steps++;
  }

  const p2OriginalTiles = join2.game.tiles.filter(t => t.owner === 1).map(t => t.id);
  for (let row = 0; row < 5; row++) {
    for (let col = 3; col < 5; col++) {
      const pos = row * 5 + col;
      assert.equal(p2OriginalTiles.includes(currentBoard[pos]), true);
    }
  }

  const unauthorizedSwap = await fetch(base + '/api/games/' + code + '/swap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: 'p1-autosolve', from: 0, to: 3 })
  });
  assert.equal(unauthorizedSwap.status, 400);

  const devSolve = await fetch(base + '/api/games/' + code + '/solve', { method: 'POST' });
  assert.equal(devSolve.status, 200);
  const finalState = await firstEvent(await fetch(base + '/api/games/' + code + '/events'));
  assert.equal(finalState.done, true);
}

themeLogicUnitTests();
persistenceChecks()
  .then(() => console.log('All tests passed: Theme resolution, 5x5/6x6/9x9 geometry, SQLite persistence, restart, 9 multiplayer regression checks, and Demo Auto-Solve ownership isolation.'))
  .catch(error => { console.error(error); process.exitCode = 1; });
