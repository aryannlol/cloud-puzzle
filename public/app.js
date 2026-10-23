const $ = id => document.getElementById(id);
let game, player, events, selected = null, preview = false, debug = false, inflight = 0, hint = null, notice = '';
// Unique per-tab identifier: preserved across reloads of this tab, fresh for new tabs/windows.
const _navType = performance.getEntriesByType('navigation')[0]?.type;
const _isReload = _navType === 'reload' || _navType === 'back_forward';
const themeNames = { light: 'Light', dark: 'Dark', system: 'System' };

function getStoredTheme() {
  try {
    const val = localStorage.getItem('cloudPuzzleTheme');
    if (val === 'light' || val === 'dark' || val === 'system') return val;
  } catch {}
  return 'system';
}

function setStoredTheme(theme) {
  try {
    localStorage.setItem('cloudPuzzleTheme', theme);
  } catch {}
}

function getEffectiveTheme(preference) {
  if (preference === 'light' || preference === 'dark') return preference;
  return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
}

function updateThemeUI(pref, effective) {
  const label = 'Theme: ' + (themeNames[pref] || 'System');
  const aria = 'Current theme: ' + (themeNames[pref] || 'System') + ' (' + effective + '). Click to cycle theme.';
  if ($('theme')) {
    $('theme').textContent = label;
    $('theme').setAttribute('aria-label', aria);
  }
  if ($('theme-in-game')) {
    $('theme-in-game').textContent = label;
    $('theme-in-game').setAttribute('aria-label', aria);
  }
}

function applyTheme(choice) {
  const pref = (choice === 'light' || choice === 'dark' || choice === 'system') ? choice : 'system';
  setStoredTheme(pref);
  const effective = getEffectiveTheme(pref);
  document.documentElement.dataset.theme = effective;
  updateThemeUI(pref, effective);
}

function cycleTheme() {
  const current = getStoredTheme();
  const next = current === 'system' ? 'light' : current === 'light' ? 'dark' : 'system';
  applyTheme(next);
}

if (window.matchMedia) {
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onSystemThemeChange = () => {
      if (getStoredTheme() === 'system') {
        const effective = mq.matches ? 'dark' : 'light';
        document.documentElement.dataset.theme = effective;
        updateThemeUI('system', effective);
      }
    };
    if (mq.addEventListener) mq.addEventListener('change', onSystemThemeChange);
    else if (mq.addListener) mq.addListener(onSystemThemeChange);
  } catch {}
}

function post(url, data) { return fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) }).then(async response => { const result = await response.json(); if (!response.ok) throw Error(result.error); return result; }); }
function escapeHTML(text) { return String(text).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function showMessage(text, error = true) { notice = text; $('game-message').textContent = text; $('game-message').style.color = error ? 'var(--coral)' : 'var(--mint)'; }
function homeMessage(id, text) { $(id).textContent = text; }
function tileStyle(tile) {
  const last = Math.max(1, game.size - 1);
  return 'background-image:url(' + game.image + ');background-size:' + game.size * 100 + '% ' + game.size * 100 + '%;background-position:' + tile.col / last * 100 + '% ' + tile.row / last * 100 + '%';
}
function regionBounds(owner) { const base = Math.floor(game.size / game.playerCount), extra = game.size % game.playerCount, start = owner * base + Math.min(owner, extra); return { start, end:start + base + (owner < extra ? 1 : 0) }; }
function updatePlayerOptions() { const size = Number($('size').value), previous = Number($('count').value) || 2; $('count').innerHTML = ''; for (let n = 2; n <= size; n++) $('count').add(new Option(n, n)); $('count').value = String(Math.min(previous, size)); }
function setBusy(button, busy, label) { button.disabled = busy; button.dataset.original = button.dataset.original || button.innerHTML; button.innerHTML = busy ? 'Working…' : button.dataset.original; }
function regionLabel(owner) { const region = regionBounds(owner); return 'Columns ' + region.start + '–' + (region.end - 1); }
let setupMode = '';
function openSetup(mode) {
  setupMode = mode; $('setup-title').textContent = mode === 'create' ? 'Create game' : 'Join game';
  $('setup-message').textContent = '';
  $('setup-fields').innerHTML = mode === 'create'
    ? '<label for="setup-name">Your name</label><input id="setup-name" required autofocus placeholder="Your name"><label for="setup-image">Source image</label><input id="setup-image" type="file" accept="image/*" required><div class="field-row"><div><label for="setup-players">Players</label><select id="setup-players"></select></div><div><label for="setup-size">Grid size</label><select id="setup-size"><option value="5">5 × 5</option><option value="6">6 × 6</option><option value="9" selected>9 × 9</option></select></div></div>'
    : '<label for="setup-name">Your name</label><input id="setup-name" required autofocus placeholder="Your name"><label for="setup-code">Room code</label><input id="setup-code" required maxlength="10" placeholder="ROOM CODE" autocomplete="off">';
  if (mode === 'create') { const size = $('setup-size'), players = $('setup-players'); const fill = () => { const current = Number(players.value) || 2; players.innerHTML = ''; for (let n = 2; n <= Number(size.value); n++) players.add(new Option(n, n)); players.value = String(Math.min(current, Number(size.value))); }; size.onchange = fill; fill(); }
  $('setup-dialog').showModal(); $('setup-name').focus();
}

function renderProgress() {
  $('players').innerHTML = game.players.map(p => {
    const percentage = Math.round(p.correct / p.total * 100);
    return '<div class="player player-' + p.owner + '"><div class="player-top"><div class="player-name">' + escapeHTML(p.name) + '</div><strong>' + percentage + '%</strong></div><div class="progress-track"><div class="progress-fill" style="width:' + percentage + '%"></div></div><small>' + p.correct + ' of ' + p.total + ' tiles</small></div>';
  }).join('');
}
function renderCompletion() {
  const done = game.done; $('completion').hidden = !done; $('active-content').hidden = done;
  if (!done) return;
  stopAutoSolve();
  $('completed-image').src = game.image;
  $('final-players').innerHTML = game.players.map(p => '<div class="player player-' + p.owner + '"><div class="player-name">' + escapeHTML(p.name) + '</div><small>' + p.correct + '/' + p.total + ' tiles solved</small></div>').join('');
}

// Each player only ever changes their own columns, so the server never disagrees with the local board.
// That makes optimistic moves safe: apply instantly, confirm in the background.
function inMyRegion(position) { const r = regionBounds(player.owner), col = position % game.size; return col >= r.start && col < r.end; }
function recount(p) { return game.board.reduce((n, id, pos) => n + (id === Math.floor(pos / game.size) + '-' + pos % game.size && game.tiles[pos].owner === p.owner ? 1 : 0), 0); }
function applyServerState(data) {
  const prev = game;
  if (player && Array.isArray(data.players)) {
    const me = data.players.find(p => p.id === player.id);
    if (me) player = { ...player, ...me };
  }
  const board = (inflight > 0)
    ? prev.board.map((id, i) => inMyRegion(i) ? id : data.board[i])
    : data.board;
  game = { ...prev, ...data, board, tiles: data.tiles || prev.tiles, image: prev.image };
  render();
}
function layoutBoard() {
  if (!game || !player || !game.size) return;
  const boardEl = $('board');
  if (!boardEl) return;
  const boardTop = boardEl.getBoundingClientRect().top || 70;
  const isLandscape = window.innerWidth > window.innerHeight;
  const parentWidth = boardEl.parentElement ? boardEl.parentElement.clientWidth : window.innerWidth;
  const availableWidth = Math.max(120, parentWidth - 8);
  const bottomMargin = isLandscape ? 20 : 70;
  const availableHeight = Math.max(120, window.innerHeight - boardTop - bottomMargin);
  const maxBoardDim = Math.min(availableWidth, availableHeight);
  const cellSize = Math.max(12, Math.floor(maxBoardDim / game.size));
  boardEl.style.setProperty('--grid-size', game.size);
  boardEl.style.setProperty('--region-columns', game.size);
  boardEl.style.setProperty('--cell-width', cellSize + 'px');
  boardEl.style.setProperty('--cell-height', cellSize + 'px');
}

let autoSolveTimer = null;
let autoSolveActive = false;

function updateAutoSolveUI() {
  const btn = $('solve-btn');
  if (!btn) return;
  if (autoSolveActive) {
    btn.textContent = '⏹ Stop Auto Solve';
    btn.setAttribute('aria-label', 'Stop running Demo Auto Solve');
    btn.classList.add('auto-solve-running');
  } else {
    btn.textContent = 'Demo Auto Solve';
    btn.setAttribute('aria-label', 'Start step-by-step Demo Auto Solve for your region');
    btn.classList.remove('auto-solve-running');
  }
}

function stopAutoSolve(reason) {
  if (autoSolveTimer) {
    clearTimeout(autoSolveTimer);
    autoSolveTimer = null;
  }
  if (autoSolveActive) {
    autoSolveActive = false;
    updateAutoSolveUI();
    if (reason) showMessage(reason, false);
  }
}

function stepAutoSolve() {
  if (!autoSolveActive) return;
  if (!game || game.done) {
    stopAutoSolve('Demo Auto Solve completed: puzzle solved!');
    return;
  }
  const mine = game.players.find(p => p.id === player.id) || game.players.find(p => p.owner === player.owner);
  if (mine && mine.correct >= mine.total) {
    stopAutoSolve('Your assigned region is fully solved.');
    return;
  }
  if (inflight > 0) {
    autoSolveTimer = setTimeout(stepAutoSolve, 200);
    return;
  }
  const move = findHint();
  if (!move) {
    stopAutoSolve('Your assigned region is fully solved.');
    return;
  }
  doSwap(move[0], move[1]);
  autoSolveTimer = setTimeout(stepAutoSolve, 380);
}

function startAutoSolve() {
  if (autoSolveActive) return;
  if (!game || !player) return showMessage('Join a room first.');
  if (game.done) return showMessage('Game is already complete.');
  const confirmed = window.confirm('Start Demo Auto Solve?\nThis will automatically solve your assigned region step-by-step for demonstration.');
  if (!confirmed) return;
  autoSolveActive = true;
  updateAutoSolveUI();
  showMessage('Demo Auto Solve running… Click "Stop Auto Solve" or anywhere on the board to cancel.', false);
  stepAutoSolve();
}

function toggleAutoSolve() {
  if (autoSolveActive) stopAutoSolve('Demo Auto Solve stopped.');
  else startAutoSolve();
}
function findHint() { // optimal move: always put a tile where it belongs; prefer swaps that fix two tiles at once
  const region = regionBounds(player.owner), want = p => Math.floor(p / game.size) + '-' + p % game.size;
  let first = null;
  for (let row = 0; row < game.size; row++) for (let col = region.start; col < region.end; col++) {
    const p = row * game.size + col; if (game.board[p] === want(p)) continue;
    const q = game.board.indexOf(want(p));
    if (game.board[p] === want(q)) return [p, q];
    if (!first) first = [p, q];
  }
  return first;
}
function doSwap(a, b) {
  [game.board[a], game.board[b]] = [game.board[b], game.board[a]];
  for (const p of game.players) if (p.owner === player.owner) p.correct = recount(p);
  selected = null; hint = null; render();
  inflight++;
  post('/api/games/' + game.code + '/swap', { playerId:player.id, from:a, to:b })
    .catch(async error => { showMessage(error.message); try { const r = await post('/api/games/' + game.code + '/join', { id:player.id, name:player.name, lite:true }); game = { ...game, board:r.game.board, players:r.game.players }; } catch {} })
    .finally(() => { inflight--; render(); });
}
function onBoardClick(event) {
  if (autoSolveActive) {
    stopAutoSolve('Demo Auto Solve stopped by user interaction.');
  }
  const cell = event.target.closest('.cell'); if (!cell || preview || !game || game.done) return;
  const position = Number(cell.dataset.pos); if (!inMyRegion(position)) return; hint = null;
  if (selected === null) { selected = position; render(); }
  else if (selected === position) { selected = null; render(); }
  else doSwap(selected, position);
}
function render() {
  if (!game || !player) return;
  document.body.classList.add('in-game'); $('home').hidden = true; $('game').hidden = false; $('room').textContent = game.code; $('player-name').textContent = player.name; $('player-region').textContent = 'Player ' + (player.owner + 1) + ' · ' + regionLabel(player.owner); $('connected-count').textContent = game.players.length + '/' + game.playerCount + ' joined';
  $('home').style.display = 'none'; $('game').style.display = 'block';
  const total = game.size * game.size;
  if (!game.image || !game.size || !Array.isArray(game.board) || game.board.length !== total || !Array.isArray(game.tiles) || game.tiles.length !== total) { showMessage('Puzzle data is incomplete. Refresh and create a new room.'); return; }
  const mine = game.players.find(p => p.id === player.id) || game.players.find(p => p.owner === player.owner) || { correct: 0, total: 1 }, region = regionBounds(player.owner), tiles = new Map(game.tiles.map(tile => [tile.id, tile])), correctBoard = game.tiles.map(tile => tile.id);
  $('player-dot').className = 'player-dot player-' + player.owner; $('region-label').textContent = 'Your region — Player ' + (player.owner + 1); $('region-meta').textContent = mine.correct + '/' + mine.total + ' tiles correct · ' + Math.round(mine.correct / mine.total * 100) + '%';
  $('game-status').textContent = game.done ? 'Complete' : game.players.length < game.playerCount ? 'Waiting for players' : preview ? 'Preview only' : 'Playing'; $('preview').textContent = preview ? 'Exit preview' : 'Preview correct region'; $('debug').checked = debug; if ($('reference').getAttribute('src') !== game.image) { $('reference').onload = () => { if (game && player) render(); }; $('reference').src = game.image; }
  $('region-label').textContent = player.name + ' · Player ' + (player.owner + 1) + ' · ' + regionLabel(player.owner);
  $('player-progress').style.width = Math.round(mine.correct / mine.total * 100) + '%';
  $('preview').innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6Z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/></svg><span>' + (preview ? 'Exit' : 'Preview') + '</span>';
  layoutBoard();
  const frag = document.createDocumentFragment(), bg = 'background-image:url(' + game.image + ');background-size:' + game.size * 100 + '% ' + game.size * 100 + '%;';
  const last = Math.max(1, game.size - 1);
  // Build column-to-owner map from tiles so we can colour-code every column
  const colOwner = new Array(game.size).fill(0);
  for (const t of game.tiles) colOwner[t.col] = t.owner;
  for (let row = 0; row < game.size; row++) for (let col = 0; col < game.size; col++) {
    const position = row * game.size + col, cellOwner = colOwner[col], isOwn = cellOwner === player.owner;
    const tile = tiles.get(preview ? correctBoard[position] : game.board[position]);
    if (!tile) return showMessage('A puzzle tile is missing. Refresh and create a new room.');
    const cell = document.createElement('button'); cell.type = 'button'; cell.dataset.pos = position;
    const isSelected = isOwn && selected === position;
    const isHint = isOwn && hint && (hint[0] === position || hint[1] === position);
    cell.className = 'cell region-' + cellOwner + (!isOwn ? ' other-region' : '') + (isSelected ? ' selected' : '') + (isHint ? ' hint' : '') + (preview && isOwn ? ' preview-cell' : '');
    cell.style.cssText = bg + 'background-position:' + tile.col / last * 100 + '% ' + tile.row / last * 100 + '%';
    cell.setAttribute('aria-label', 'Tile originally at row ' + tile.row + ', column ' + tile.col);
    cell.disabled = !isOwn || preview;
    if (debug) { const coords = document.createElement('span'); coords.className = 'coords'; coords.textContent = tile.row + ',' + tile.col; cell.append(coords); }
    frag.append(cell);
  }
  $('board').replaceChildren(frag);
  renderProgress(); renderCompletion(); if (!notice) $('game-message').textContent = '';
}
function normalizedImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        if (!image.naturalWidth || !image.naturalHeight) return reject(Error('The image could not be decoded.'));
        // Resize to a reasonable maximum while preserving the complete source image and its aspect ratio.
        const scale = Math.min(1, 1400 / image.naturalWidth, 1000 / image.naturalHeight);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext('2d');
        if (!context) return reject(Error('Image processing is unavailable in this browser.'));
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', .9));
      };
      image.onerror = () => reject(Error('The image could not be loaded.'));
      image.src = reader.result;
    };
    reader.onerror = () => reject(Error('The image file could not be read.'));
    reader.readAsDataURL(file);
  });
}
async function joinRoom(code, name, resume = false) {
  try {
    const key = 'puzzlePlayer:' + code;
    let playerId = (_isReload || resume) ? sessionStorage.getItem(key) : null;
    if (!playerId) {
      playerId = crypto.randomUUID();
      sessionStorage.setItem(key, playerId);
    }
    const result = await post('/api/games/' + code + '/join', { id: playerId, name, lite: true });
    player = result.player; game = result.game; game.image = '/api/games/' + game.code + '/image';
    sessionStorage.setItem(key, player.id);
    sessionStorage.setItem('puzzleName:' + game.code, player.name);
    sessionStorage.puzzleRoom = game.code;
    try { history.replaceState(null, '', '?room=' + game.code); } catch {}
    stopAutoSolve();
    selected = null; preview = false; hint = null; inflight = 0; notice = '';
    events && events.close();
    events = new EventSource('/api/games/' + code + '/events?lite=1');
    events.onopen = () => { $('connection-status').textContent = 'Connected'; $('connection').classList.remove('offline'); };
    events.onerror = () => { stopAutoSolve('Connection dropped. Demo Auto Solve paused.'); $('connection-status').textContent = 'Reconnecting…'; $('connection').classList.add('offline'); };
    events.onmessage = event => {
      const data = JSON.parse(event.data);
      if (data.expired) {
        leaveHome();
        if ($('home-status')) $('home-status').textContent = data.message || 'Room was closed due to inactivity.';
        localStorage.removeItem('puzzleRoom');
        checkResumeBanner();
        return;
      }
      applyServerState(data);
    };
    render();
  } catch (error) {
    if (resume) {
      if ($('home-status')) $('home-status').textContent = error.message.includes('Not found') ? 'Room ' + code + ' is no longer active (it was closed for inactivity or the server was reset).' : 'Reconnecting failed: ' + error.message;
      localStorage.removeItem('puzzleRoom');
      sessionStorage.removeItem('puzzleRoom');
      try { history.replaceState(null, '', window.location.pathname); } catch {}
      checkResumeBanner();
    } else {
      homeMessage(code === $('code').value.trim().toUpperCase() ? 'join-message' : 'create-message', error.message);
    }
  }
}

if ($('theme')) $('theme').onclick = cycleTheme;
if ($('theme-in-game')) $('theme-in-game').onclick = cycleTheme;
applyTheme(getStoredTheme());
updatePlayerOptions();
$('size').onchange = updatePlayerOptions;
$('create-entry').onclick = () => openSetup('create');
$('join-entry').onclick = () => openSetup('join');
$('setup-cancel').onclick = () => $('setup-dialog').close();
$('setup-form').onsubmit = async event => {
  event.preventDefault(); const submit = $('setup-submit'); submit.disabled = true; $('setup-message').textContent = '';
  try {
    const name = $('setup-name').value.trim();
    if (!name) throw Error('Enter your name.');
    if (setupMode === 'create') {
      const file = $('setup-image').files[0]; if (!file) throw Error('Choose an image.');
      const image = await normalizedImage(file), result = await post('/api/games', { players:$('setup-players').value, size:$('setup-size').value, image });
      $('setup-dialog').close(); await joinRoom(result.code, name);
    } else {
      const code = $('setup-code').value.trim().toUpperCase(); if (!code) throw Error('Enter a room code.');
      $('setup-dialog').close(); await joinRoom(code, name);
    }
  } catch (error) { $('setup-message').textContent = error.message; } finally { submit.disabled = false; }
};
$('code').oninput = () => { $('code').value = $('code').value.replace(/\s/g, '').toUpperCase(); };
$('create-form').onsubmit = async event => { event.preventDefault(); homeMessage('create-message', ''); const button = $('create'); setBusy(button, true); try { const image = await normalizedImage($('image').files[0]); const result = await post('/api/games', { players:$('count').value, size:$('size').value, image }); await joinRoom(result.code, $('create-name').value.trim()); } catch (error) { homeMessage('create-message', error.message); } finally { setBusy(button, false); } };
$('join-form').onsubmit = async event => { event.preventDefault(); homeMessage('join-message', ''); const code = $('code').value.trim().toUpperCase(), name = $('join-name').value.trim(); if (!code || !name) return homeMessage('join-message', 'Enter your name and a room code.'); const button = $('join'); setBusy(button, true); await joinRoom(code, name); setBusy(button, false); };
$('board').onclick = onBoardClick;
if ($('hint')) $('hint').onclick = () => { if (!game || game.done || preview) return; hint = findHint(); selected = null; render(); };
$('preview').onclick = () => { preview = !preview; selected = null; render(); }; $('debug').onchange = event => { debug = event.target.checked; render(); };
$('solve-btn').onclick = toggleAutoSolve;
window.addEventListener('keydown', e => {
  if (e.shiftKey && (e.key === 'S' || e.key === 's')) {
    if (!game || game.done) return;
    if (window.confirm('Developer instant solve: Solve entire board on server?')) {
      post('/api/games/' + game.code + '/solve', {}).catch(err => showMessage(err.message));
    }
  }
});
$('reference').onerror = () => { $('reference').removeAttribute('src'); $('reference').alt = 'Original image could not be loaded'; showMessage('The original image could not be loaded. Refresh and create the room again.'); };
$('copy-room').onclick = async () => { try { await navigator.clipboard.writeText(game.code); $('copy-room').textContent = 'Copied!'; setTimeout(() => $('copy-room').textContent = 'Copy code', 1400); } catch { showMessage('Copy was not available. Room code: ' + game.code); } };
function checkResumeBanner() {
  const lastRoom = localStorage.puzzleRoom;
  if (lastRoom && $('resume-container') && $('resume-code')) {
    $('resume-container').style.display = 'block';
    $('resume-code').textContent = lastRoom;
  } else if ($('resume-container')) {
    $('resume-container').style.display = 'none';
  }
}
function leaveHome() {
  stopAutoSolve();
  events && events.close();
  game = player = null;
  sessionStorage.removeItem('puzzleRoom');
  sessionStorage.removeItem('puzzleName');
  try { history.replaceState(null, '', window.location.pathname); } catch {}
  document.body.classList.remove('in-game');
  $('completion').hidden = true;
  $('active-content').hidden = false;
  $('game-message').textContent = '';
  $('game').hidden = true;
  $('game').style.display = '';
  $('home').hidden = false;
  $('home').style.display = '';
  checkResumeBanner();
}
$('leave').onclick = leaveHome; $('play-again').onclick = leaveHome;
if ($('resume-btn')) {
  $('resume-btn').onclick = () => {
    const code = localStorage.puzzleRoom;
    if (code) {
      const savedPlayerId = sessionStorage.getItem('puzzlePlayer:' + code);
      const savedPlayerName = sessionStorage.getItem('puzzleName:' + code);
      if (savedPlayerId) {
        joinRoom(code, savedPlayerName || 'Player', true);
      } else {
        openSetup('join');
        if ($('setup-code')) $('setup-code').value = code;
      }
    }
  };
}
let resizeFrame = 0;
window.addEventListener('resize', () => { cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(layoutBoard); });
const urlParams = new URLSearchParams(window.location.search);
const targetRoom = urlParams.get('room');
if (targetRoom) {
  const savedPlayerId = sessionStorage.getItem('puzzlePlayer:' + targetRoom);
  const savedPlayerName = sessionStorage.getItem('puzzleName:' + targetRoom);
  if (savedPlayerId) {
    joinRoom(targetRoom, savedPlayerName || 'Player', true);
  } else {
    openSetup('join');
    if ($('setup-code')) $('setup-code').value = targetRoom;
  }
} else if (sessionStorage.puzzleRoom && sessionStorage.getItem('puzzlePlayer:' + sessionStorage.puzzleRoom)) {
  const room = sessionStorage.puzzleRoom;
  joinRoom(room, sessionStorage.getItem('puzzleName:' + room) || 'Player', true);
} else {
  checkResumeBanner();
}

if ($('thumb-btn')) $('thumb-btn').onclick = () => { if (game && game.image) { $('modal-img').src = game.image; $('image-modal').showModal(); } };
if ($('close-modal-btn')) $('close-modal-btn').onclick = () => $('image-modal').close();
if ($('image-modal')) $('image-modal').onclick = e => { if (e.target === $('image-modal')) $('image-modal').close(); };
if ($('theme-in-game')) $('theme-in-game').onclick = cycleTheme;
