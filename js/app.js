// boggle-bd - DOM wiring. Depends on WORDS (js/words.js), the pure logic
// functions (js/logic.js) and I18N (js/i18n.js). No network calls.
'use strict';

const TRIE = buildTrie(WORDS);
const DICT = new Set(WORDS);
const LS_SETTINGS = 'boggle-bd-settings';
const LS_BEST = 'boggle-bd-best';
const LS_HISTORY = 'boggle-bd-history';
const MAX_HINTS = 3;
const MAX_MISSED_SHOWN = 200;

const $ = (id) => document.getElementById(id);

function loadJSON(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v == null ? fallback : v;
  } catch (e) { return fallback; }
}
function saveJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
}

const settings = Object.assign(
  { size: 4, duration: 180, lang: 'en', muted: false },
  loadJSON(LS_SETTINGS, {})
);
let best = Object.assign({ '4': 0, '5': 0 }, loadJSON(LS_BEST, {}));
let history = loadJSON(LS_HISTORY, []);
if (!Array.isArray(history)) history = [];

// --- Game state ---
let phase = 'setup'; // setup | playing | paused | over
let board = null;
let solved = []; // all board words, sorted length desc then alpha
let path = [];
let found = new Map(); // word -> points
let score = 0;
let hintsUsed = 0;
let timeLeft = settings.duration;
let timerId = null;
let dragging = false;
let suppressClickUntil = 0;

function t(key) {
  const lang = settings.lang;
  return (I18N[lang] && I18N[lang][key]) || I18N.en[key] || key;
}
function n(v) { return fmtNum(v, settings.lang); }
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  $('langBtn').textContent = settings.lang === 'en' ? '\u09AC\u09BE\u0982\u09B2\u09BE' : 'English';
  $('muteBtn').textContent = settings.muted ? t('unmute') : t('mute');
  document.documentElement.lang = settings.lang === 'bn' ? 'bn' : 'en';
  renderStats();
  renderFound();
  renderHistory();
  renderSetupBest();
  updateHintButton();
}

// --- Sound (tiny WebAudio blips) ---
let audioCtx = null;
function blip(freq, ms) {
  if (settings.muted) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + ms / 1000);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + ms / 1000);
  } catch (e) { /* audio unavailable: stay silent */ }
}

// --- Board rendering ---
function renderBoard() {
  const el = $('board');
  el.innerHTML = '';
  el.style.gridTemplateColumns = 'repeat(' + board.size + ', 1fr)';
  el.classList.toggle('hidden-board', phase === 'paused');
  board.tiles.forEach((tile, idx) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tile';
    b.dataset.idx = String(idx);
    b.setAttribute('role', 'gridcell');
    b.setAttribute('aria-label', 'Tile ' + tile.display);
    b.textContent = tile.display;
    const pos = path.indexOf(idx);
    if (pos >= 0) {
      b.classList.add('selected');
      const ord = document.createElement('span');
      ord.className = 'ord';
      ord.textContent = n(pos + 1);
      b.appendChild(ord);
    }
    b.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      if (phase !== 'playing') return;
      dragging = true;
      suppressClickUntil = Date.now() + 350;
      addTile(idx);
    });
    b.addEventListener('pointerenter', () => {
      if (dragging && phase === 'playing') addTile(idx);
    });
    b.addEventListener('click', () => {
      if (Date.now() < suppressClickUntil) return;
      if (phase !== 'playing') return;
      addTile(idx);
    });
    el.appendChild(b);
  });
}
document.addEventListener('pointerup', () => { dragging = false; });
document.addEventListener('pointercancel', () => { dragging = false; });

function addTile(idx) {
  if (phase !== 'playing') return;
  if (path.length === 0) {
    path.push(idx);
    blip(600, 60);
    renderBoard();
    renderCurrentWord();
    return;
  }
  const last = path[path.length - 1];
  if (idx === last) { // tap last tile again = undo it
    path.pop();
    blip(500, 50);
    renderBoard();
    renderCurrentWord();
    return;
  }
  if (path.includes(idx)) { showError('errReuse'); blip(180, 120); return; }
  if (!isAdjacent(board, last, idx)) { showError('errNotAdjacent'); blip(180, 120); return; }
  path.push(idx);
  blip(600, 60);
  hideError();
  renderBoard();
  renderCurrentWord();
}

function currentWord() {
  return path.length ? wordFromPath(board, path) : '';
}

function renderCurrentWord() {
  const w = currentWord();
  $('currentWord').textContent = w ? w.toUpperCase() : '\u2014';
  $('scorePreview').textContent = w && w.length >= 3
    ? '+' + n(scoreWord(w)) + ' ' + t('points')
    : '';
}

function renderStats() {
  $('scoreVal').textContent = n(score);
  $('timeVal').textContent = settings.lang === 'bn' ? toBnDigits(formatTime(timeLeft)) : formatTime(timeLeft);
  $('wordsVal').textContent = n(found.size);
  $('bestVal').textContent = best[String(board ? board.size : settings.size)] > 0
    ? n(best[String(board ? board.size : settings.size)])
    : '\u2014';
}

function renderSetupBest() {
  $('setupBest').textContent =
    '4\u00D7' + '4: ' + (best['4'] > 0 ? n(best['4']) : '\u2014') +
    ' \u00B7 5\u00D7' + '5: ' + (best['5'] > 0 ? n(best['5']) : '\u2014');
}

function renderFound() {
  const list = $('foundList');
  list.innerHTML = '';
  const words = Array.from(found.entries()).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  $('foundEmpty').hidden = words.length > 0;
  for (const [w, pts] of words) {
    const li = document.createElement('li');
    li.textContent = w.toUpperCase();
    const s = document.createElement('span');
    s.className = 'pts';
    s.textContent = '+' + n(pts);
    li.appendChild(s);
    list.appendChild(li);
  }
}

function renderHistory() {
  const body = $('historyBody');
  body.innerHTML = '';
  $('historyEmpty').hidden = history.length > 0;
  $('historyTable').hidden = history.length === 0;
  for (const h of history) {
    const tr = document.createElement('tr');
    const d = new Date(h.date);
    const cells = [
      isNaN(d) ? h.date : d.toLocaleDateString(settings.lang === 'bn' ? 'bn-BD' : 'en-GB'),
      n(h.size) + '\u00D7' + n(h.size),
      n(h.score),
      n(h.words),
      (h.bestWord || '\u2014').toUpperCase(),
    ];
    for (const c of cells) {
      const td = document.createElement('td');
      td.textContent = c;
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
}

function showError(key) {
  const el = $('gameError');
  el.textContent = t(key);
  el.hidden = false;
}
function hideError() { $('gameError').hidden = true; }
function updateHintButton() {
  $('hintsLeft').textContent = '(' + n(MAX_HINTS - hintsUsed) + ')';
  $('hintBtn').disabled = phase !== 'playing' || hintsUsed >= MAX_HINTS;
}

// --- Game flow ---
function fixedBoardFromURL() {
  const m = new URLSearchParams(location.search).get('board');
  if (!m) return null;
  const letters = m.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const size = Math.sqrt(letters.length);
  if (!Number.isInteger(size) || size < 2 || size > 6) return null;
  if (letters.some((l) => l !== 'qu' && !/^[a-z]$/.test(l))) return null;
  try { return boardFromLetters(size, letters); } catch (e) { return null; }
}

function startGame() {
  const fixed = fixedBoardFromURL();
  board = fixed || genBoard(settings.size);
  solved = solveBoard(board, TRIE);
  path = [];
  found = new Map();
  score = 0;
  hintsUsed = 0;
  timeLeft = settings.duration;
  phase = 'playing';
  $('setupPanel').hidden = true;
  $('resultsPanel').hidden = true;
  $('gamePanel').hidden = false;
  $('pausedCover').hidden = true;
  $('hintLine').hidden = true;
  hideError();
  renderBoard();
  renderCurrentWord();
  renderStats();
  renderFound();
  updateHintButton();
  $('pauseBtn').textContent = t('pause');
  clearInterval(timerId);
  timerId = setInterval(tick, 1000);
}

function tick() {
  if (phase !== 'playing') return;
  timeLeft -= 1;
  renderStats();
  if (timeLeft <= 0) endGame();
}

function submitWord() {
  if (phase !== 'playing') return;
  const v = validatePath(board, path);
  if (!v.ok) {
    showError(v.error === 'tooShort' ? 'errTooShort' : v.error === 'reuse' ? 'errReuse' : 'errNotAdjacent');
    blip(180, 120);
    return;
  }
  const word = v.word;
  const res = validateSubmission(word, new Set(found.keys()), (w) => DICT.has(w));
  if (!res.ok) {
    showError(res.error === 'tooShort' ? 'errTooShort' : res.error === 'duplicate' ? 'errDuplicate' : 'errNotInDict');
    blip(180, 120);
    return;
  }
  const pts = scoreWord(word);
  found.set(word, pts);
  score += pts;
  path = [];
  hideError();
  blip(880, 90);
  renderBoard();
  renderCurrentWord();
  renderStats();
  renderFound();
  updateHintButton();
}

function endGame() {
  clearInterval(timerId);
  phase = 'over';
  dragging = false;
  const sizeKey = String(board.size);
  const isBest = score > (best[sizeKey] || 0);
  if (isBest) best[sizeKey] = score;
  saveJSON(LS_BEST, best);
  let longest = '';
  for (const w of found.keys()) {
    if (w.length > longest.length || (w.length === longest.length && w < longest)) longest = w;
  }
  const entry = {
    date: new Date().toISOString(),
    size: board.size,
    score,
    words: found.size,
    bestWord: longest || null,
  };
  history.unshift(entry);
  history = history.slice(0, 5);
  saveJSON(LS_HISTORY, history);

  const missed = solved.filter((w) => !found.has(w)).slice(0, MAX_MISSED_SHOWN);
  $('finalScore').textContent = n(score);
  $('finalWords').textContent = n(found.size);
  $('finalLongest').textContent = longest ? longest.toUpperCase() : '\u2014';
  $('finalPossible').textContent = n(solved.length);
  $('newBestBadge').hidden = !isBest;
  const rf = $('resultsFound');
  rf.innerHTML = '';
  for (const [w, pts] of Array.from(found.entries()).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) {
    const li = document.createElement('li');
    li.textContent = w.toUpperCase();
    const s = document.createElement('span');
    s.className = 'pts';
    s.textContent = '+' + n(pts);
    li.appendChild(s);
    rf.appendChild(li);
  }
  const ml = $('missedList');
  ml.innerHTML = '';
  for (const w of missed) {
    const li = document.createElement('li');
    li.textContent = w.toUpperCase();
    const s = document.createElement('span');
    s.className = 'pts';
    s.textContent = '+' + n(scoreWord(w));
    li.appendChild(s);
    ml.appendChild(li);
  }
  const totalMissed = solved.filter((w) => !found.has(w)).length;
  $('missedNote').textContent = totalMissed > MAX_MISSED_SHOWN
    ? n(MAX_MISSED_SHOWN) + ' / ' + n(totalMissed)
    : '';
  $('gamePanel').hidden = true;
  $('resultsPanel').hidden = false;
  renderHistory();
  renderSetupBest();
  blip(440, 200);
}

function pauseGame() {
  if (phase === 'playing') {
    phase = 'paused';
    $('pausedCover').hidden = false;
    $('pauseBtn').textContent = t('resume');
    renderBoard();
  } else if (phase === 'paused') {
    phase = 'playing';
    $('pausedCover').hidden = true;
    $('pauseBtn').textContent = t('pause');
    renderBoard();
  }
}

function useHint() {
  if (phase !== 'playing') return;
  if (hintsUsed >= MAX_HINTS) { showError('noHintsLeft'); return; }
  const w = pickHint(solved, new Set(found.keys()));
  if (!w) { showError('noMoreHints'); return; }
  hintsUsed += 1;
  const line = $('hintLine');
  line.textContent = t('hintWord') + ': ' + w.toUpperCase() + ' (+' + n(scoreWord(w)) + ' ' + t('points') + ')';
  line.hidden = false;
  hideError();
  blip(740, 90);
  updateHintButton();
}

// --- Events ---
$('startBtn').addEventListener('click', () => {
  const sizeEl = document.querySelector('input[name="size"]:checked');
  const durEl = document.querySelector('input[name="duration"]:checked');
  settings.size = sizeEl ? Number(sizeEl.value) : 4;
  settings.duration = durEl ? Number(durEl.value) : 180;
  saveJSON(LS_SETTINGS, settings);
  startGame();
});
$('submitBtn').addEventListener('click', submitWord);
$('undoBtn').addEventListener('click', () => {
  if (phase !== 'playing') return;
  path.pop();
  hideError();
  renderBoard();
  renderCurrentWord();
});
$('clearBtn').addEventListener('click', () => {
  if (phase !== 'playing') return;
  path = [];
  hideError();
  renderBoard();
  renderCurrentWord();
});
$('hintBtn').addEventListener('click', useHint);
$('pauseBtn').addEventListener('click', pauseGame);
$('newGameBtn').addEventListener('click', () => {
  clearInterval(timerId);
  phase = 'setup';
  $('gamePanel').hidden = true;
  $('resultsPanel').hidden = true;
  $('setupPanel').hidden = false;
  renderSetupBest();
});
$('playAgainBtn').addEventListener('click', () => {
  $('resultsPanel').hidden = true;
  $('setupPanel').hidden = false;
  phase = 'setup';
  renderSetupBest();
});
$('langBtn').addEventListener('click', () => {
  settings.lang = settings.lang === 'en' ? 'bn' : 'en';
  saveJSON(LS_SETTINGS, settings);
  applyI18n();
});
$('muteBtn').addEventListener('click', () => {
  settings.muted = !settings.muted;
  saveJSON(LS_SETTINGS, settings);
  applyI18n();
});
document.addEventListener('keydown', (ev) => {
  if (phase !== 'playing') return;
  if (ev.key === 'Enter') { ev.preventDefault(); submitWord(); }
  else if (ev.key === 'Backspace') {
    ev.preventDefault();
    path.pop();
    hideError();
    renderBoard();
    renderCurrentWord();
  }
  else if (ev.key === 'Escape') {
    path = [];
    hideError();
    renderBoard();
    renderCurrentWord();
  }
});

// --- Init ---
document.querySelector('input[name="size"][value="' + settings.size + '"]').checked = true;
document.querySelector('input[name="duration"][value="' + settings.duration + '"]').checked = true;
applyI18n();

// Test/debug hook (documented in README): fixed board via ?board=,
// and programmatic end-of-game for smoke tests.
window.__boggle = {
  state: () => ({ phase, score, found: Array.from(found.keys()), solvedCount: solved.length, timeLeft, hintsUsed }),
  endGame,
  startGame,
};
