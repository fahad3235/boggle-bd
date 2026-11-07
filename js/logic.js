// boggle-bd - pure game logic (no DOM). Loadable in Node for unit tests.
// Board: array of tiles {letter: 'a'..'z' | 'qu', display: 'A'..'Z' | 'Qu'}.
// A 'q' tile always counts as the two letters "qu" in words.
// Letters are drawn by weighted random sampling from English letter
// frequencies -- NOT the licensed Boggle dice set.
'use strict';

// English letter frequencies (percent, approx. standard corpus values).
const LETTER_FREQ = [
  ['a', 8.17], ['b', 1.49], ['c', 2.78], ['d', 4.25], ['e', 12.70],
  ['f', 2.23], ['g', 2.02], ['h', 6.09], ['i', 6.97], ['j', 0.15],
  ['k', 0.77], ['l', 4.03], ['m', 2.41], ['n', 6.75], ['o', 7.51],
  ['p', 1.93], ['q', 0.10], ['r', 5.99], ['s', 6.33], ['t', 9.06],
  ['u', 2.76], ['v', 0.98], ['w', 2.36], ['x', 0.15], ['y', 1.97],
  ['z', 0.07],
];

function pickLetter(rng) {
  let r = rng() * 100;
  for (const [ch, w] of LETTER_FREQ) {
    r -= w;
    if (r <= 0) return ch;
  }
  return 'e';
}

// Generate a board of size x size. rng defaults to Math.random; inject a
// seeded rng in tests for reproducibility.
function genBoard(size, rng) {
  rng = rng || Math.random;
  const tiles = [];
  for (let i = 0; i < size * size; i++) {
    const ch = pickLetter(rng);
    if (ch === 'q') tiles.push({ letter: 'qu', display: 'Qu' });
    else tiles.push({ letter: ch, display: ch.toUpperCase() });
  }
  return { size, tiles };
}

// Build a board object from an explicit array of letter strings, e.g.
// ['c','a','t','qu',...] -- used by tests and by "fixed board" debugging.
function boardFromLetters(size, letters) {
  if (letters.length !== size * size) throw new Error('letters length must equal size*size');
  return {
    size,
    tiles: letters.map((ch) => (ch === 'qu' || ch === 'q'
      ? { letter: 'qu', display: 'Qu' }
      : { letter: ch.toLowerCase(), display: ch.toUpperCase() })),
  };
}

function rowCol(board, idx) {
  return { r: Math.floor(idx / board.size), c: idx % board.size };
}

function isAdjacent(board, a, b) {
  if (a === b) return false;
  const pa = rowCol(board, a);
  const pb = rowCol(board, b);
  return Math.abs(pa.r - pb.r) <= 1 && Math.abs(pa.c - pb.c) <= 1;
}

// Validate a path (array of tile indexes). Returns {ok:true, word} or
// {ok:false, error} where error is one of:
// 'tooShort' (path < 3 tiles -- but a path of 3+ tiles can still spell a
//   word shorter than 3 letters? No: min tile letter length is 1, so a
//   3-tile path always spells >= 3 letters), 'reuse', 'notAdjacent'.
function validatePath(board, path) {
  if (!Array.isArray(path) || path.length < 3) return { ok: false, error: 'tooShort' };
  const seen = new Set();
  for (let i = 0; i < path.length; i++) {
    const idx = path[i];
    if (typeof idx !== 'number' || idx < 0 || idx >= board.tiles.length) {
      return { ok: false, error: 'outOfRange' };
    }
    if (seen.has(idx)) return { ok: false, error: 'reuse' };
    seen.add(idx);
    if (i > 0 && !isAdjacent(board, path[i - 1], idx)) return { ok: false, error: 'notAdjacent' };
  }
  return { ok: true, word: wordFromPath(board, path) };
}

function wordFromPath(board, path) {
  return path.map((i) => board.tiles[i].letter).join('');
}

// Classic Boggle scoring by word length (letters, Qu counts as 2).
function scoreWord(word) {
  const n = word.length;
  if (n < 3) return 0;
  if (n <= 4) return 1;
  if (n === 5) return 2;
  if (n === 6) return 3;
  if (n === 7) return 5;
  return 11;
}

// --- Trie ---
function buildTrie(words) {
  const root = { end: false, next: {} };
  for (const w of words) {
    let node = root;
    for (const ch of w) {
      if (!node.next[ch]) node.next[ch] = { end: false, next: {} };
      node = node.next[ch];
    }
    node.end = true;
  }
  return root;
}

function inTrie(trie, word) {
  let node = trie;
  for (const ch of word) {
    node = node.next[ch];
    if (!node) return false;
  }
  return node.end === true;
}

// --- Solver: trie-based DFS over the board ---
// Returns all dictionary words (length 3..8) the board contains.
// Each tile used at most once per word; Q tile contributes "qu".
function solveBoard(board, trie, maxLen) {
  maxLen = maxLen || 8;
  const found = new Set();
  const size = board.size;
  const tiles = board.tiles;

  function dfs(idx, node, word, visited) {
    const tile = tiles[idx];
    let cur = node;
    for (const ch of tile.letter) {
      cur = cur.next[ch];
      if (!cur) return;
    }
    const w = word + tile.letter;
    if (w.length > maxLen) return;
    if (w.length >= 3 && cur.end) found.add(w);
    if (w.length >= maxLen) return;
    visited.add(idx);
    const { r, c } = rowCol(board, idx);
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
        const ni = nr * size + nc;
        if (!visited.has(ni)) dfs(ni, cur, w, visited);
      }
    }
    visited.delete(idx);
  }

  for (let i = 0; i < tiles.length; i++) dfs(i, trie, '', new Set());
  // Sort: length desc, then alphabetical.
  return Array.from(found).sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
}

// Validate a submitted word against the game state.
// Returns {ok:true} or {ok:false, error} where error is one of:
// 'tooShort', 'notInDict', 'duplicate'.
function validateSubmission(word, foundSet, inDict) {
  if (!word || word.length < 3) return { ok: false, error: 'tooShort' };
  if (foundSet.has(word)) return { ok: false, error: 'duplicate' };
  if (!inDict(word)) return { ok: false, error: 'notInDict' };
  return { ok: true };
}

// Pick a random un-found board word for the hint feature.
// Returns the word string, or null when every board word is found.
function pickHint(solvedWords, foundSet, rng) {
  rng = rng || Math.random;
  const remaining = solvedWords.filter((w) => !foundSet.has(w));
  if (remaining.length === 0) return null;
  return remaining[Math.floor(rng() * remaining.length)];
}

// Timer helpers.
function formatTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m + ':' + (sec < 10 ? '0' : '') + sec;
}

// Bengali digits.
const BN_DIGITS = ['\u09E6', '\u09E7', '\u09E8', '\u09E9', '\u09EA', '\u09EB', '\u09EC', '\u09ED', '\u09EE', '\u09EF'];
function toBnDigits(str) {
  return String(str).replace(/[0-9]/g, (d) => BN_DIGITS[Number(d)]);
}
function fmtNum(n, lang, decimals) {
  const s = (decimals == null ? String(n) : Number(n).toFixed(decimals));
  return lang === 'bn' ? toBnDigits(s) : s;
}

if (typeof module !== 'undefined') {
  module.exports = {
    LETTER_FREQ, genBoard, boardFromLetters, rowCol, isAdjacent,
    validatePath, wordFromPath, scoreWord, buildTrie, inTrie,
    solveBoard, validateSubmission, pickHint, formatTime,
    toBnDigits, fmtNum,
  };
}
