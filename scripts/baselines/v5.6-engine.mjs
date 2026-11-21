// scripts/board-rules.mjs
var BOARD = 15;
var idx = (r, c) => r * BOARD + c;
var inBounds = (r, c) => r >= 0 && r < BOARD && c >= 0 && c < BOARD;
var directions = [[0, 1], [1, 0], [1, 1], [1, -1]];
function count(board, r, c, dr, dc, player) {
  let n = 0;
  for (r += dr, c += dc; inBounds(r, c) && board[idx(r, c)] === player; r += dr, c += dc) n++;
  return n;
}
function winningLine(board, r, c, player) {
  for (const [dr, dc] of directions) {
    const ahead = count(board, r, c, dr, dc, player);
    const behind = count(board, r, c, -dr, -dc, player);
    if (ahead + behind + 1 < 5) continue;
    const line = [];
    for (let i = -behind; i <= ahead; i++) line.push([r + dr * i, c + dc * i]);
    return line;
  }
  return void 0;
}
function extensionsInDirection(board, r, c, dr, dc) {
  const extensions = [];
  for (let start = -3; start <= 0; start++) {
    const end = start + 4;
    const ar = r + (start - 1) * dr, ac = c + (start - 1) * dc;
    const br = r + end * dr, bc = c + end * dc;
    if (!inBounds(ar, ac) || !inBounds(br, bc) || board[idx(ar, ac)] || board[idx(br, bc)]) continue;
    let gap = null;
    let valid = true;
    for (let offset = start; offset < end; offset++) {
      const row = r + offset * dr, col = c + offset * dc;
      const cell = board[idx(row, col)];
      if (cell === 1) continue;
      if (cell !== 0 || gap) {
        valid = false;
        break;
      }
      gap = [row, col];
    }
    if (valid && gap && !extensions.some(([row, col]) => row === gap[0] && col === gap[1])) {
      extensions.push(gap);
    }
  }
  return extensions;
}
function isBlackDoubleThree(board, r, c) {
  const square = idx(r, c);
  if (!inBounds(r, c) || board[square] !== 0) return false;
  board[square] = 1;
  try {
    const directionsWithExtensions = [];
    for (const [dr, dc] of directions) {
      const extensions = extensionsInDirection(board, r, c, dr, dc);
      if (extensions.length) directionsWithExtensions.push(extensions);
    }
    if (directionsWithExtensions.length < 2 || winningLine(board, r, c, 1)) return false;
    let legalDirections = 0;
    for (const extensions of directionsWithExtensions) {
      if (extensions.some(([row, col]) => !isBlackDoubleThree(board, row, col)) && ++legalDirections === 2) return true;
    }
    return false;
  } finally {
    board[square] = 0;
  }
}

// src/game/gomoku/logic.ts
var EMPTY = 0;
var BLACK = 1;
var WHITE = 2;
function checkWin(b, r, c, player) {
  const line = winningLine(b, r, c, player);
  return line ? { win: true, line } : { win: false };
}
function forbiddenMove(board, r, c, player, rule) {
  return rule === "double-three" && player === BLACK && isBlackDoubleThree(board, r, c);
}

// src/game/gomoku/ai.ts
var DIFFICULTIES = ["easy", "beginner", "normal", "advanced", "expert", "hard"];
var RAPFI_LEVELS = {
  expert: { maxDepth: 2, timeMs: 500, strength: 10 },
  hard: { maxDepth: 99, timeMs: 3500 }
};
function usesRapfi(difficulty) {
  return difficulty === "expert" || difficulty === "hard";
}
var INF = 1e15;
var WIN = 1e9;
var VAL_FIVE = 1e6;
var VAL_LIVE4 = 1e5;
var VAL_RUSH4 = 12e3;
var VAL_LIVE3 = 8e3;
var VAL_SLEEP3 = 1e3;
var VAL_LIVE2 = 600;
var VAL_SLEEP2 = 150;
function buildTable(side) {
  const o = side === "1" ? "2" : "1";
  const defs = [
    [["XXXXX"], VAL_FIVE, 1],
    [["0XXXX0"], VAL_LIVE4, 2],
    [["XXXX0O", "O0XXXX", "XXXXO", "OXXXX", "XX0XX", "X0XXX", "XXX0X"], VAL_RUSH4, 3],
    [["0XXX00", "00XXX0", "0X0XX0", "0XX0X0"], VAL_LIVE3, 4],
    [
      [
        "OXXX00",
        "00XXXO",
        "XXX00O",
        "O00XXX",
        // 一头堵死的三
        "X0XXO",
        "OXX0X",
        "XX0XO",
        "OX0XX",
        // 断点三
        "XO0X0",
        "0X0OX",
        "0XOX0",
        "X0XO0",
        "0X0XO"
        // 间隔三
      ],
      VAL_SLEEP3,
      5
    ],
    [["00XX00", "0X0X00", "00X0X0", "0X00X0", "0XX00", "00XX0"], VAL_LIVE2, 6],
    [
      [
        "OXX000",
        "000XXO",
        "O0XX00",
        "00XX0O",
        // 一头堵住的二
        "X0X000",
        "000X0X",
        "X00X00",
        "00X00X",
        // 断点二
        "O0X0X0",
        "0X0X0O",
        "XO00X0",
        "0X00OX"
        // 特殊间隔二
      ],
      VAL_SLEEP2,
      7
    ]
  ];
  const map = new Uint32Array(32768);
  for (const [shapes, v, cls] of defs) {
    for (const raw of shapes) {
      const s = raw.replace(/X/g, side).replace(/O/g, o);
      let code = 0;
      for (let i = 0; i < s.length; i++) code = code * 3 + (s.charCodeAt(i) - 48);
      map[code + s.length * 4096] = v | cls << 24;
    }
  }
  return map;
}
var TAB_SIDE = [buildTable("1"), buildTable("2")];
var lineBuf = new Int8Array(BOARD + 2);
var clsCur = new Int32Array(8);
function scanLine(tab, len) {
  const buf = lineBuf;
  const cur = clsCur;
  cur.fill(0);
  let sc = 0;
  for (let i = 0; i < len; i++) {
    if (i + 6 <= len) {
      const code6 = ((((buf[i] * 3 + buf[i + 1]) * 3 + buf[i + 2]) * 3 + buf[i + 3]) * 3 + buf[i + 4]) * 3 + buf[i + 5] | 0;
      let e = tab[code6 + 24576];
      if (e !== 0) {
        const cls = e >>> 24;
        if (i >= cur[cls]) {
          sc += e & 16777215;
          cur[cls] = i + 6;
        }
      }
      e = tab[(code6 / 3 | 0) + 20480];
      if (e !== 0) {
        const cls = e >>> 24;
        if (i >= cur[cls]) {
          sc += e & 16777215;
          cur[cls] = i + 5;
        }
      }
    } else if (i + 5 <= len) {
      let code = 0;
      for (let k = 0; k < 5; k++) code = code * 3 + buf[i + k];
      const e = tab[code + 20480];
      if (e !== 0) {
        const cls = e >>> 24;
        if (i >= cur[cls]) {
          sc += e & 16777215;
          cur[cls] = i + 5;
        }
      }
    }
  }
  return sc;
}
function evalLine(tabMe, tabOpp, len, padMe, padOpp) {
  lineBuf[0] = padMe;
  lineBuf[len - 1] = padMe;
  const a = scanLine(tabMe, len);
  lineBuf[0] = padOpp;
  lineBuf[len - 1] = padOpp;
  const b = scanLine(tabOpp, len);
  return a - Math.round(b * 1.08);
}
function evalBoard(b, ai) {
  const tabMe = TAB_SIDE[ai - 1];
  const tabOpp = TAB_SIDE[ai === BLACK ? 1 : 0];
  const padMe = ai === BLACK ? 2 : 1;
  const padOpp = ai;
  const N = BOARD;
  let score = 0;
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) lineBuf[c + 1] = b[idx(r, c)];
    score += evalLine(tabMe, tabOpp, N + 2, padMe, padOpp);
  }
  for (let c = 0; c < N; c++) {
    for (let r = 0; r < N; r++) lineBuf[r + 1] = b[idx(r, c)];
    score += evalLine(tabMe, tabOpp, N + 2, padMe, padOpp);
  }
  for (let s = -(N - 5); s <= N - 5; s++) {
    let len = 0;
    for (let r = 0; r < N; r++) {
      const c = r - s;
      if (c < 0 || c >= N) continue;
      lineBuf[len + 1] = b[idx(r, c)];
      len++;
    }
    if (len < 5) continue;
    score += evalLine(tabMe, tabOpp, len + 2, padMe, padOpp);
  }
  for (let s = 4; s <= 2 * N - 6; s++) {
    let len = 0;
    for (let r = 0; r < N; r++) {
      const c = s - r;
      if (c < 0 || c >= N) continue;
      lineBuf[len + 1] = b[idx(r, c)];
      len++;
    }
    if (len < 5) continue;
    score += evalLine(tabMe, tabOpp, len + 2, padMe, padOpp);
  }
  return score;
}
var LINES = (() => {
  const out = [];
  const N = BOARD;
  for (let r = 0; r < N; r++) {
    const cells = new Uint8Array(N);
    for (let c = 0; c < N; c++) cells[c] = idx(r, c);
    out.push({ cells });
  }
  for (let c = 0; c < N; c++) {
    const cells = new Uint8Array(N);
    for (let r = 0; r < N; r++) cells[r] = idx(r, c);
    out.push({ cells });
  }
  for (let s = -(N - 5); s <= N - 5; s++) {
    const cells = [];
    for (let r = 0; r < N; r++) {
      const c = r - s;
      if (c >= 0 && c < N) cells.push(idx(r, c));
    }
    if (cells.length >= 5) out.push({ cells: Uint8Array.from(cells) });
  }
  for (let s = 4; s <= 2 * N - 6; s++) {
    const cells = [];
    for (let r = 0; r < N; r++) {
      const c = s - r;
      if (c >= 0 && c < N) cells.push(idx(r, c));
    }
    if (cells.length >= 5) out.push({ cells: Uint8Array.from(cells) });
  }
  return out;
})();
var LINE_COUNT = LINES.length;
var CELL_LINES = (() => {
  const lists = Array.from({ length: BOARD * BOARD }, () => []);
  for (let lid = 0; lid < LINE_COUNT; lid++) {
    for (const cell of LINES[lid].cells) lists[cell].push(lid);
  }
  return lists.map((l) => Uint8Array.from(l));
})();
var lineVal1 = new Int32Array(LINE_COUNT);
var lineVal2 = new Int32Array(LINE_COUNT);
var tot1 = 0;
var tot2 = 0;
var totW1 = 0;
var totW2 = 0;
var snapCell = new Int32Array(40);
var snapT1 = new Int32Array(40);
var snapT2 = new Int32Array(40);
var snapW1 = new Int32Array(40);
var snapW2 = new Int32Array(40);
var snapVals = new Int32Array(40 * 8);
function snapshotCell(ply, i) {
  snapCell[ply] = i;
  snapT1[ply] = tot1;
  snapT2[ply] = tot2;
  snapW1[ply] = totW1;
  snapW2[ply] = totW2;
  let k = 0;
  for (const lid of CELL_LINES[i]) {
    snapVals[ply * 8 + k * 2] = lineVal1[lid];
    snapVals[ply * 8 + k * 2 + 1] = lineVal2[lid];
    k++;
  }
}
function restoreCell(ply) {
  const i = snapCell[ply];
  let k = 0;
  for (const lid of CELL_LINES[i]) {
    lineVal1[lid] = snapVals[ply * 8 + k * 2];
    lineVal2[lid] = snapVals[ply * 8 + k * 2 + 1];
    k++;
  }
  tot1 = snapT1[ply];
  tot2 = snapT2[ply];
  totW1 = snapW1[ply];
  totW2 = snapW2[ply];
}
function refreshLine(b, lid) {
  const cells = LINES[lid].cells;
  const n = cells.length;
  for (let k = 0; k < n; k++) lineBuf[k + 1] = b[cells[k]];
  lineBuf[0] = 2;
  lineBuf[n + 1] = 2;
  const v1 = scanLine(TAB_SIDE[0], n + 2);
  lineBuf[0] = 1;
  lineBuf[n + 1] = 1;
  const v2 = scanLine(TAB_SIDE[1], n + 2);
  tot1 += v1 - lineVal1[lid];
  tot2 += v2 - lineVal2[lid];
  totW1 += Math.round(v1 * 1.08) - Math.round(lineVal1[lid] * 1.08);
  totW2 += Math.round(v2 * 1.08) - Math.round(lineVal2[lid] * 1.08);
  lineVal1[lid] = v1;
  lineVal2[lid] = v2;
}
function refreshCell(b, i) {
  for (const lid of CELL_LINES[i]) refreshLine(b, lid);
}
function initEval(b) {
  lineVal1.fill(0);
  lineVal2.fill(0);
  tot1 = 0;
  tot2 = 0;
  totW1 = 0;
  totW2 = 0;
  for (let lid = 0; lid < LINE_COUNT; lid++) refreshLine(b, lid);
}
function evalFast(me) {
  return me === BLACK ? tot1 - totW2 : tot2 - totW1;
}
function patternScore(count2, open) {
  if (count2 >= 5) return 1e6;
  if (count2 === 4) return open === 2 ? 1e5 : open === 1 ? 12e3 : 0;
  if (count2 === 3) return open === 2 ? 8e3 : open === 1 ? 1e3 : 0;
  if (count2 === 2) return open === 2 ? 600 : open === 1 ? 150 : 0;
  return open === 2 ? 40 : 0;
}
var DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];
function pointScore(b, r, c, player) {
  let total = 0;
  for (const [dr, dc] of DIRS) {
    let count2 = 1;
    let open = 0;
    let rr = r + dr, cc = c + dc;
    while (inBounds(rr, cc) && b[idx(rr, cc)] === player) {
      count2++;
      rr += dr;
      cc += dc;
    }
    if (inBounds(rr, cc) && b[idx(rr, cc)] === EMPTY) open++;
    rr = r - dr;
    cc = c - dc;
    while (inBounds(rr, cc) && b[idx(rr, cc)] === player) {
      count2++;
      rr -= dr;
      cc -= dc;
    }
    if (inBounds(rr, cc) && b[idx(rr, cc)] === EMPTY) open++;
    total += patternScore(count2, open);
  }
  return total;
}
var nearMask = new Uint8Array(BOARD * BOARD);
var near1Mask = new Uint8Array(BOARD * BOARD);
var nbrCnt = new Uint8Array(BOARD * BOARD);
function fillNear(b) {
  nearMask.fill(0);
  near1Mask.fill(0);
  nbrCnt.fill(0);
  let stones = 0;
  for (let i = 0; i < b.length; i++) {
    if (b[i] === EMPTY) continue;
    stones++;
    const r = i / BOARD | 0, c = i % BOARD;
    for (let dr = -2; dr <= 2; dr++) {
      const rr = r + dr;
      if (rr < 0 || rr >= BOARD) continue;
      const rowBase = rr * BOARD;
      for (let dc = -2; dc <= 2; dc++) {
        const cc = c + dc;
        if (cc < 0 || cc >= BOARD) continue;
        const j = rowBase + cc;
        if (b[j] === EMPTY) nearMask[j] = 1;
      }
    }
    for (let dr = -1; dr <= 1; dr++) {
      const rr = r + dr;
      if (rr < 0 || rr >= BOARD) continue;
      const rowBase = rr * BOARD;
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const cc = c + dc;
        if (cc < 0 || cc >= BOARD) continue;
        const j = rowBase + cc;
        nbrCnt[j]++;
        if (b[j] === EMPTY) near1Mask[j] = 1;
      }
    }
  }
  return stones;
}
function candidates(b) {
  if (fillNear(b) === 0) return [[7, 7]];
  const out = [];
  for (let i = 0; i < b.length; i++) if (nearMask[i]) out.push([i / BOARD | 0, i % BOARD]);
  return out;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = a + 1831565813 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
var rnd = mulberry32(1493);
var Z1 = new Uint32Array(BOARD * BOARD * 2);
var Z2 = new Uint32Array(BOARD * BOARD * 2);
for (let i = 0; i < Z1.length; i++) {
  Z1[i] = rnd() * 4294967295 >>> 0;
  Z2[i] = rnd() * 4294967295 >>> 0;
}
function hashKey(h1, h2) {
  return (h1 >>> 0) * 65536 + (h2 & 65535);
}
var TT_EXACT = 0;
var TT_LOWER = 1;
var TT_UPPER = 2;
var TT = /* @__PURE__ */ new Map();
var TT_LIMIT = 6e5;
function ttProbe(h1, h2, depth, alpha, beta) {
  const hit = TT.get(hashKey(h1, h2));
  if (!hit || hit.d < depth) return null;
  if (hit.flag === TT_EXACT) return hit.v;
  if (hit.flag === TT_LOWER && hit.v >= beta) return hit.v;
  if (hit.flag === TT_UPPER && hit.v <= alpha) return hit.v;
  return null;
}
function ttStore(h1, h2, depth, flag, v) {
  if (TT.size > TT_LIMIT) TT.clear();
  TT.set(hashKey(h1, h2), { d: depth, flag, v });
}
var vcfMemo = /* @__PURE__ */ new Map();
var vcfNodes = 0;
var vcfStop = false;
function threatCells(b, player, threshold) {
  fillNear(b);
  const out = [];
  for (let i = 0; i < b.length; i++) {
    if (!near1Mask[i]) continue;
    if (pointScore(b, i / BOARD | 0, i % BOARD, player) >= threshold) out.push(i);
  }
  return out;
}
var other = (p) => p === BLACK ? WHITE : BLACK;
function vcfWin(b, me, h1, h2, ctx) {
  if (vcfStop) return false;
  if ((++vcfNodes & 255) === 0 && performance.now() > ctx.deadline) {
    vcfStop = true;
    return false;
  }
  const key = hashKey(h1, h2) * 2 + (me - 1);
  const hit = vcfMemo.get(key);
  if (hit !== void 0) return hit;
  const opp = other(me);
  let result;
  if (threatCells(b, me, FIVE_SCORE).length > 0) {
    result = true;
  } else {
    const oppFive = threatCells(b, opp, FIVE_SCORE);
    if (oppFive.length >= 2) {
      result = false;
    } else if (oppFive.length === 1) {
      const i = oppFive[0];
      const r = i / BOARD | 0, c = i % BOARD;
      const zh1 = h1 ^ Z1[i * 2 + (me - 1)];
      const zh2 = h2 ^ Z2[i * 2 + (me - 1)];
      b[i] = me;
      const { win } = checkWin(b, r, c, me);
      if (win) result = true;
      else if (threatCells(b, me, FOUR_SCORE).length > 0) result = false;
      else result = !vcfWin(b, opp, zh1, zh2, ctx);
      b[i] = EMPTY;
    } else {
      result = false;
      const fours = threatCells(b, me, FOUR_SCORE);
      for (const i of fours) {
        const r = i / BOARD | 0, c = i % BOARD;
        const zh1 = h1 ^ Z1[i * 2 + (me - 1)];
        const zh2 = h2 ^ Z2[i * 2 + (me - 1)];
        b[i] = me;
        const blocks = threatCells(b, me, FIVE_SCORE);
        let res;
        if (blocks.length >= 2) res = true;
        else if (blocks.length === 1) {
          const bi = blocks[0];
          const br = bi / BOARD | 0, bc = bi % BOARD;
          const bh1 = zh1 ^ Z1[bi * 2 + (opp - 1)];
          const bh2 = zh2 ^ Z2[bi * 2 + (opp - 1)];
          b[bi] = opp;
          const w2 = checkWin(b, br, bc, opp).win;
          res = !w2 && threatCells(b, opp, FOUR_SCORE).length === 0 && vcfWin(b, me, bh1, bh2, ctx);
          b[bi] = EMPTY;
        } else {
          res = false;
        }
        b[i] = EMPTY;
        if (res) {
          result = true;
          break;
        }
        if (vcfStop) break;
      }
    }
  }
  if (!vcfStop) vcfMemo.set(key, result);
  return result;
}
function vcfFindMove(b, ai, ctx) {
  const opp = other(ai);
  if (threatCells(b, opp, FIVE_SCORE).length > 0) return null;
  let h1 = 0, h2 = 0;
  for (let i = 0; i < b.length; i++) {
    const v = b[i];
    if (v !== EMPTY) {
      h1 ^= Z1[i * 2 + (v - 1)];
      h2 ^= Z2[i * 2 + (v - 1)];
    }
  }
  const fours = threatCells(b, ai, FOUR_SCORE);
  for (const i of fours) {
    const r = i / BOARD | 0, c = i % BOARD;
    const zh1 = h1 ^ Z1[i * 2 + (ai - 1)];
    const zh2 = h2 ^ Z2[i * 2 + (ai - 1)];
    b[i] = ai;
    const blocks = threatCells(b, ai, FIVE_SCORE);
    let win = false;
    if (blocks.length >= 2) win = true;
    else if (blocks.length === 1) {
      const bi = blocks[0];
      const br = bi / BOARD | 0, bc = bi % BOARD;
      b[bi] = opp;
      const w2 = checkWin(b, br, bc, opp).win;
      win = !w2 && threatCells(b, opp, FOUR_SCORE).length === 0 && vcfWin(b, ai, 0, 0, ctx);
      b[bi] = EMPTY;
    }
    b[i] = EMPTY;
    if (win) return { r, c, player: ai };
    if (vcfStop) return null;
  }
  return null;
}
var FIVE_SCORE = 1e6;
var FOUR_SCORE = 12e3;
function gather(b, me, opp, style = "balanced", rule = "freestyle") {
  const stones = fillNear(b);
  if (stones === 0) {
    const i = idx(7, 7);
    return [{ r: 7, c: 7, i, atk: 0, def: 0, score: 1 }];
  }
  const list = [];
  const checkForbidden = rule === "double-three" && stones >= 4;
  for (let i = 0; i < b.length; i++) {
    if (!nearMask[i]) continue;
    const r = i / BOARD | 0, c = i % BOARD;
    const forbidden = checkForbidden && forbiddenMove(b, r, c, BLACK, rule);
    if (forbidden && me === BLACK) continue;
    const atk = pointScore(b, r, c, me);
    const def = forbidden ? 0 : pointScore(b, r, c, opp);
    let score;
    if (atk >= FIVE_SCORE) score = FIVE_SCORE * 4 + atk;
    else if (def >= FIVE_SCORE) score = FIVE_SCORE * 3 + def;
    else if (style === "attack") score = Math.round(atk * 1.3 + def * 0.86);
    else if (style === "defense") score = Math.round(atk * 0.86 + def * 1.24);
    else score = atk + Math.round(def * 0.9);
    list.push({ r, c, i, atk, def, score });
  }
  if (checkForbidden && me === BLACK && list.length === 0) {
    const i = b.findIndex((cell, index) => cell === EMPTY && !nearMask[index]);
    if (i >= 0) list.push({ r: Math.floor(i / BOARD), c: i % BOARD, i, atk: 0, def: 0, score: 0 });
  }
  return list;
}
function moveHints(board, player, rule = "freestyle") {
  const ranked = gather(board, player, other(player), "balanced", rule).sort((a, b) => b.score - a.score);
  const first = ranked[0];
  if (!first) return null;
  const mustWin = first.atk >= FIVE_SCORE;
  const mustBlock = !mustWin && first.def >= FIVE_SCORE;
  const choices = mustWin ? ranked.filter((move) => move.atk >= FIVE_SCORE) : mustBlock ? ranked.filter((move) => move.def >= FIVE_SCORE) : ranked;
  const recommendation = mustWin || mustBlock ? first : bestMove(board, player, "normal", Math.random, "balanced", rule) ?? first;
  const candidates2 = [recommendation, ...choices.filter(
    (move) => move.r !== recommendation.r || move.c !== recommendation.c
  )].slice(0, 3).map(({ r, c }) => ({ r, c, player }));
  const vertical = ["上", "中", "下"][Math.floor(recommendation.r / 5)];
  const horizontal = ["左", "中", "右"][Math.floor(recommendation.c / 5)];
  const area = vertical === horizontal ? "中腹" : `${horizontal}${vertical}`;
  return { candidates: candidates2, area, urgency: mustWin ? "win" : mustBlock || first.def >= FOUR_SCORE ? "defense" : "position" };
}
function stylePreferences(board, player, style) {
  if (style === "balanced") return null;
  const ranked = gather(board, player, other(player), style);
  if (ranked.some(({ atk, def }) => atk >= FIVE_SCORE || def >= FIVE_SCORE)) return null;
  const values = Array(board.length).fill(0);
  for (const { i, atk, def } of ranked) {
    const attack = Math.log1p(atk);
    const defense = Math.log1p(def);
    values[i] = Math.round(24 * (style === "attack" ? attack - 0.7 * defense : defense - 0.7 * attack));
  }
  return values;
}
function negamax(b, me, depth, alpha, beta, ply, h1, h2, ctx) {
  ctx.nodes++;
  if ((ctx.nodes & (ctx.rule === "double-three" ? 127 : 1023)) === 0 && performance.now() > ctx.deadline) {
    ctx.abort = true;
    return 0;
  }
  const alphaOrig = alpha;
  const cached = ttProbe(h1, h2, depth, alpha, beta);
  if (cached !== null) return cached;
  if (depth <= 0) {
    const base = evalFast(me);
    if (ctx.style === "balanced") return base;
    const mine = ctx.ai === BLACK ? tot1 : tot2;
    const theirs = ctx.ai === BLACK ? tot2 : tot1;
    const bias = Math.round((ctx.style === "attack" ? mine : -theirs) * 0.23);
    return base + (me === ctx.ai ? bias : -bias);
  }
  const opp = me === BLACK ? WHITE : BLACK;
  const all = gather(b, me, opp, "balanced", ctx.rule);
  if (all.length === 0) return ctx.rule === "double-three" && me === BLACK && b.includes(EMPTY) ? -WIN + ply : 0;
  const five = all.find((m) => m.atk >= FIVE_SCORE);
  if (five) return WIN - ply;
  const blocks = all.filter((m) => m.def >= FIVE_SCORE);
  let moves;
  let ext = 0;
  if (blocks.length > 0) {
    moves = blocks;
  } else {
    all.sort((a, z) => z.score - a.score);
    const forcingMoves = ply < 24 ? all.filter((m) => m.atk >= FOUR_SCORE) : [];
    if (forcingMoves.length > 0 && forcingMoves.length <= 3) {
      moves = forcingMoves;
      ext = 2;
    } else {
      moves = all.slice(0, depth >= 4 ? 10 : 8);
    }
  }
  const childDepth = Math.min(depth - 1 + ext, 28 - ply);
  let best = -INF;
  let flag = TT_UPPER;
  for (let k = 0; k < moves.length; k++) {
    const m = moves[k];
    const zh1 = h1 ^ Z1[m.i * 2 + (me - 1)];
    const zh2 = h2 ^ Z2[m.i * 2 + (me - 1)];
    b[m.i] = me;
    snapshotCell(ply, m.i);
    refreshCell(b, m.i);
    const { win } = checkWin(b, m.r, m.c, me);
    let v;
    if (win) {
      v = WIN - ply;
    } else if (k === 0) {
      v = -negamax(b, opp, childDepth, -beta, -alpha, ply + 1, zh1, zh2, ctx);
    } else {
      v = -negamax(b, opp, childDepth, -alpha - 1, -alpha, ply + 1, zh1, zh2, ctx);
      if (!ctx.abort && v > alpha && v < beta) {
        v = -negamax(b, opp, childDepth, -beta, -alpha, ply + 1, zh1, zh2, ctx);
      }
    }
    b[m.i] = EMPTY;
    restoreCell(ply);
    if (ctx.abort) return 0;
    if (v > best) best = v;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  flag = best >= beta ? TT_LOWER : best > alphaOrig ? TT_EXACT : TT_UPPER;
  ttStore(h1, h2, depth, flag, best);
  return best;
}
var previousEvaluation = "";
function iterativeDeepening(b, ai, maxDepth = 14, timeMs = 3e3, variant = 0, style = "balanced", rule = "freestyle") {
  const evaluation = `${rule}:${style === "balanced" ? style : `${style}-${ai}`}`;
  if (evaluation !== previousEvaluation) TT.clear();
  previousEvaluation = evaluation;
  const ctx = { deadline: performance.now() + timeMs, nodes: 0, abort: false, ai, style, rule };
  const opp = ai === BLACK ? WHITE : BLACK;
  const root = gather(b, ai, opp, style, rule);
  if (root.length === 0) return { move: null, depth: 0, nodes: 0, score: 0 };
  const five = root.find((m) => m.atk >= FIVE_SCORE);
  if (five) return { move: { r: five.r, c: five.c, player: ai }, depth: 0, nodes: 1, score: WIN };
  const mustBlock = root.filter((m) => m.def >= FIVE_SCORE);
  if (mustBlock.length > 0) {
    mustBlock.sort((a, z) => z.score - a.score);
    return { move: { r: mustBlock[0].r, c: mustBlock[0].c, player: ai }, depth: 0, nodes: 1, score: 0 };
  }
  if (maxDepth >= 8 && rule === "freestyle") {
    vcfMemo.clear();
    vcfNodes = 0;
    vcfStop = false;
    const vcfCtx = { ...ctx, deadline: performance.now() + Math.min(timeMs * 0.25, 500) };
    const vcfMove = vcfFindMove(b, ai, vcfCtx);
    vcfStop = false;
    if (vcfMove) return { move: vcfMove, depth: 0, nodes: vcfNodes, score: WIN };
  }
  root.sort((a, z) => z.score - a.score);
  initEval(b);
  const top = root.slice(0, variant === 1 ? 10 : 12);
  let best = top[0];
  let bestScore = 0;
  let completed = 0;
  let h1 = 0, h2 = 0;
  for (let i = 0; i < b.length; i++) {
    const v = b[i];
    if (v !== EMPTY) {
      h1 ^= Z1[i * 2 + (v - 1)];
      h2 ^= Z2[i * 2 + (v - 1)];
    }
  }
  const ASPIRATION = 6e4;
  for (let d = 2; d <= maxDepth; d += 2) {
    const ordered = [best, ...top.filter((m) => m !== best)];
    let alpha = completed > 0 && variant === 0 ? bestScore - ASPIRATION : -INF;
    let beta = completed > 0 && variant === 0 ? bestScore + ASPIRATION : INF;
    const searchOnce = (a0, b0) => {
      let iterBest2 = null;
      let a = a0;
      for (let k = 0; k < ordered.length; k++) {
        const m = ordered[k];
        const zh1 = h1 ^ Z1[m.i * 2 + (ai - 1)];
        const zh2 = h2 ^ Z2[m.i * 2 + (ai - 1)];
        b[m.i] = ai;
        refreshCell(b, m.i);
        const { win } = checkWin(b, m.r, m.c, ai);
        let v;
        if (win) v = WIN;
        else if (k === 0) v = -negamax(b, opp, d - 1, -b0, -a, 1, zh1, zh2, ctx);
        else {
          v = -negamax(b, opp, d - 1, -a - 1, -a, 1, zh1, zh2, ctx);
          if (!ctx.abort && v > a && v < b0) v = -negamax(b, opp, d - 1, -b0, -a, 1, zh1, zh2, ctx);
        }
        b[m.i] = EMPTY;
        refreshCell(b, m.i);
        if (ctx.abort) break;
        if (iterBest2 === null || v > a) {
          a = Math.max(a, v);
          iterBest2 = m;
        }
      }
      return { m: iterBest2, v: a };
    };
    let { m: iterBest, v: score } = searchOnce(alpha, beta);
    if (!ctx.abort && completed > 0 && variant === 0 && (score <= alpha || score >= beta)) {
      ({ m: iterBest, v: score } = searchOnce(-INF, INF));
    }
    if (ctx.abort || !iterBest) break;
    best = iterBest;
    bestScore = score;
    completed = d;
  }
  return { move: { r: best.r, c: best.c, player: ai }, depth: completed, nodes: ctx.nodes, score: bestScore };
}
function bestMove(b, ai, difficulty, rand = Math.random, style = "balanced", rule = "freestyle") {
  if (difficulty === "easy" || difficulty === "beginner") {
    const ranked = gather(b, ai, other(ai), style, rule).sort((a, z) => z.score - a.score);
    const best = ranked[0];
    if (!best) return null;
    const pick = difficulty === "easy" && best.atk < FIVE_SCORE && best.def < FIVE_SCORE && rand() < 0.34 ? ranked[1] ?? best : best;
    return { r: pick.r, c: pick.c, player: ai };
  }
  if (difficulty === "normal") {
    const res2 = iterativeDeepening(b, ai, 2, 500, 0, style, rule);
    return res2.move;
  }
  if (difficulty === "advanced" || difficulty === "expert") {
    return iterativeDeepening(b, ai, 6, 240, 0, style, rule).move;
  }
  const res = iterativeDeepening(b, ai, 12, 2500, 0, style, rule);
  return res.move;
}
export {
  DIFFICULTIES,
  RAPFI_LEVELS,
  bestMove,
  candidates,
  evalBoard,
  iterativeDeepening,
  moveHints,
  pointScore,
  stylePreferences,
  usesRapfi
};
