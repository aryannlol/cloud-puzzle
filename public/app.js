const $ = id => document.getElementById(id);
let game, player, events, selected = null, preview = false, debug = false, inflight = 0, hint = null, notice = '';
// Fresh page loads and duplicated tabs get a new UUID; reloads/back-forward keep the same one.
// This lets two browser tabs join the same room as different players without losing identity on refresh.
const _navType = performance.getEntriesByType('navigation')[0]?.type;
const _isReload = _navType === 'reload' || _navType === 'back_forward';
let identity = (_isReload && sessionStorage.puzzlePlayer) ? sessionStorage.puzzlePlayer : crypto.randomUUID();
sessionStorage.puzzlePlayer = identity;
const themeNames = { light:'Light', dark:'Dark', system:'System' };

function post(url, data) { return fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) }).then(async response => { const result = await response.json(); if (!response.ok) throw Error(result.error); return result; }); }
function escapeHTML(text) { return String(text).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function showMessage(text, error = true) { notice = text; $('game-message').textContent = text; $('game-message').style.color = error ? 'var(--coral)' : 'var(--mint)'; }
function homeMessage(id, text) { $(id).textContent = text; }
function applyTheme(choice) { const actual = choice === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : choice; document.documentElement.dataset.theme = actual; localStorage.cloudPuzzleTheme = choice; if ($('theme')) $('theme').innerHTML = '<span>Theme: ' + themeNames[choice] + '</span>'; if ($('theme-in-game')) $('theme-in-game').textContent = 'Theme: ' + themeNames[choice]; }
function cycleTheme() { const current = localStorage.cloudPuzzleTheme || 'system', next = current === 'system' ? 'light' : current === 'light' ? 'dark' : 'system'; applyTheme(next); }
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
  $('completed-image').src = game.image;
  $('final-players').innerHTML = game.players.map(p => '<div class="player player-' + p.owner + '"><div class="player-name">' + escapeHTML(p.name) + '</div><small>' + p.correct + '/' + p.total + ' tiles solved</small></div>').join('');
}

// Each player only ever changes their own columns, so the server never disagrees with the local board.
// That makes optimistic moves safe: apply instantly, confirm in the background.
function inMyRegion(position) { const r = regionBounds(player.owner), col = position % game.size; return col >= r.start && col < r.end; }
function recount(p) { return game.board.reduce((n, id, pos) => n + (id === Math.floor(pos / game.size) + '-' + pos % game.size && game.tiles[pos].owner === p.owner ? 1 : 0), 0); }
function applyServerState(data) {
  const full = Array.isArray(data.tiles);                       // first message after (re)connect carries everything
  const prev = game, mineBefore = prev.board.filter((_, i) => inMyRegion(i)).join();
  const board = (full && inflight === 0) ? data.board : prev.board.map((id, i) => inMyRegion(i) ? id : data.board[i]);
  game = { ...prev, ...data, board, tiles: data.tiles || prev.tiles, image: prev.image };
  const mineAfter = game.board.filter((_, i) => inMyRegion(i)).join();
  if (mineBefore !== mineAfter || data.done || full || data.players.length !== prev.players.length) { selected = mineBefore !== mineAfter ? null : selected; render(); }
  else { renderProgress(); const me = game.players.find(p => p.owner === player.owner); if (me) { $('region-meta').textContent = me.correct + '/' + me.total + ' tiles correct · ' + Math.round(me.correct / me.total * 100) + '%'; $('player-progress').style.width = Math.round(me.correct / me.total * 100) + '%'; } $('connected-count').textContent = game.players.length + '/' + game.playerCount + ' joined'; }
}
function layoutBoard() {
  if (!game || !player || !game.size) return;
  const region = regionBounds(player.owner), columns = region.end - region.start, ref = $('reference');
  const imageAspect = ref.naturalWidth > 0 && ref.naturalHeight > 0 ? ref.naturalWidth / ref.naturalHeight : 1;
  const mobile = window.innerWidth <= 768, boardTop = $('board').getBoundingClientRect().top || 75;
  const availableHeight = mobile ? Number.POSITIVE_INFINITY : Math.max(160, window.innerHeight - boardTop - 24);
  const availableWidth = Math.max(160, $('board').parentElement.clientWidth - 4);
  const cellWidth = Math.max(16, Math.floor(Math.min(availableWidth / columns, availableHeight * imageAspect / game.size)));
  $('board').style.setProperty('--region-columns', columns);
  $('board').style.setProperty('--grid-size', game.size);
  $('board').style.setProperty('--cell-width', cellWidth + 'px');
  $('board').style.setProperty('--cell-height', Math.floor(cellWidth / imageAspect) + 'px');
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
  const cell = event.target.closest('.cell'); if (!cell || preview || !game || game.done) return;
  const position = Number(cell.dataset.pos); hint = null;
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
  const mine = game.players.find(p => p.owner === player.owner), region = regionBounds(player.owner), tiles = new Map(game.tiles.map(tile => [tile.id, tile])), correctBoard = game.tiles.map(tile => tile.id);
  $('player-dot').className = 'player-dot player-' + player.owner; $('region-label').textContent = 'Your region — Player ' + (player.owner + 1); $('region-meta').textContent = mine.correct + '/' + mine.total + ' tiles correct · ' + Math.round(mine.correct / mine.total * 100) + '%';
  $('game-status').textContent = game.done ? 'Complete' : game.players.length < game.playerCount ? 'Waiting for players' : preview ? 'Preview only' : 'Playing'; $('preview').textContent = preview ? 'Exit preview' : 'Preview correct region'; $('debug').checked = debug; if ($('reference').getAttribute('src') !== game.image) { $('reference').onload = () => { if (game && player) render(); }; $('reference').src = game.image; }
  $('region-label').textContent = player.name + ' · Player ' + (player.owner + 1) + ' · ' + regionLabel(player.owner);
  $('player-progress').style.width = Math.round(mine.correct / mine.total * 100) + '%';
  $('preview').innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6Z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/></svg><span>' + (preview ? 'Exit' : 'Preview') + '</span>';
  layoutBoard();
  const frag = document.createDocumentFragment(), bg = 'background-image:url(' + game.image + ');background-size:' + game.size * 100 + '% ' + game.size * 100 + '%;';
  const last = Math.max(1, game.size - 1);
  for (let row = 0; row < game.size; row++) for (let col = region.start; col < region.end; col++) {
    const position = row * game.size + col, tile = tiles.get(preview ? correctBoard[position] : game.board[position]);
    if (!tile) return showMessage('A puzzle tile is missing. Refresh and create a new room.');
    const cell = document.createElement('button'); cell.type = 'button'; cell.dataset.pos = position;
    cell.className = 'cell region-' + player.owner + (selected === position ? ' selected' : '') + (hint && (hint[0] === position || hint[1] === position) ? ' hint' : '') + (preview ? ' preview-cell' : '');
    cell.style.cssText = bg + 'background-position:' + tile.col / last * 100 + '% ' + tile.row / last * 100 + '%';
    cell.setAttribute('aria-label', 'Tile originally at row ' + tile.row + ', column ' + tile.col); cell.disabled = preview;
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
    const result = await post('/api/games/' + code + '/join', { id:identity, name, lite:true });
    player = result.player; game = result.game; game.image = '/api/games/' + game.code + '/image';
    try { localStorage['puzzleId:' + game.code] = identity; } catch {}
    localStorage.puzzleRoom = sessionStorage.puzzleRoom = game.code;
    localStorage.puzzleName = sessionStorage.puzzleName = player.name;
    try { history.replaceState(null, '', '?room=' + game.code); } catch {}
    selected = null; preview = false; hint = null; inflight = 0; notice = '';
    events && events.close();
    events = new EventSource('/api/games/' + code + '/events?lite=1');
    events.onopen = () => { $('connection-status').textContent = 'Connected'; $('connection').classList.remove('offline'); };
    events.onerror = () => { $('connection-status').textContent = 'Reconnecting…'; $('connection').classList.add('offline'); };
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

$('theme').onclick = cycleTheme; applyTheme(localStorage.cloudPuzzleTheme || 'system'); updatePlayerOptions(); $('size').onchange = updatePlayerOptions;
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
const triggerSolve = async () => { if (!game || game.done) return; try { await post('/api/games/' + game.code + '/solve', {}); } catch (e) { showMessage(e.message); } };
$('solve-btn').onclick = triggerSolve;
window.addEventListener('keydown', e => { if (e.shiftKey && (e.key === 'S' || e.key === 's')) triggerSolve(); });
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
    const name = localStorage.puzzleName || 'Player';
    if (code) { const saved = localStorage['puzzleId:' + code]; if (saved) identity = saved; joinRoom(code, name, true); }
  };
}
let resizeFrame = 0;
window.addEventListener('resize', () => { cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(layoutBoard); });
const urlParams = new URLSearchParams(window.location.search);
const targetRoom = urlParams.get('room') || sessionStorage.puzzleRoom || localStorage.puzzleRoom;
const targetName = sessionStorage.puzzleName || localStorage.puzzleName || 'Player';
if (targetRoom) {
  joinRoom(targetRoom, targetName, true);
} else {
  checkResumeBanner();
}

if ($('thumb-btn')) $('thumb-btn').onclick = () => { if (game && game.image) { $('modal-img').src = game.image; $('image-modal').showModal(); } };
if ($('close-modal-btn')) $('close-modal-btn').onclick = () => $('image-modal').close();
if ($('image-modal')) $('image-modal').onclick = e => { if (e.target === $('image-modal')) $('image-modal').close(); };
if ($('theme-in-game')) $('theme-in-game').onclick = cycleTheme;
