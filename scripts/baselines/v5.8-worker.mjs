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
var offsets = [-4, -3, -2, -1, 1, 2, 3, 4];
var weights = offsets.map((_, bit) => 3 ** bit);
var patternTables;
function doubleThreeTables() {
  const extensions = new Uint8Array(3 ** offsets.length);
  const cell = (code, offset) => offset === 0 ? 1 : Math.floor(code / weights[offsets.indexOf(offset)]) % 3;
  for (let code = 0; code < extensions.length; code++) {
    for (let start = -3; start <= 0; start++) {
      if (cell(code, start - 1) || cell(code, start + 4)) continue;
      let gap = 0, stones = 0;
      for (let offset = start; offset < start + 4; offset++) {
        const value = cell(code, offset);
        if (value === 1) stones++;
        if (value === 0) gap = offset;
      }
      if (stones === 3 && gap) extensions[code] |= 1 << offsets.indexOf(gap);
    }
  }
  const blocked = new Uint16Array(BOARD * BOARD * directions.length);
  const links = Array.from({ length: BOARD * BOARD }, () => []);
  for (let r = 0; r < BOARD; r++) {
    for (let c = 0; c < BOARD; c++) {
      const base = idx(r, c) * directions.length;
      directions.forEach(([dr, dc], direction) => {
        offsets.forEach((offset, bit) => {
          const row = r + dr * offset, col = c + dc * offset;
          const line = base + direction;
          if (inBounds(row, col)) links[idx(row, col)].push(line, weights[bit]);
          else blocked[line] += 2 * weights[bit];
        });
      });
    }
  }
  return { extensions, blocked, links: links.map((link) => Uint16Array.from(link)) };
}
function createDoubleThreeIndex(board) {
  const { extensions, blocked, links } = patternTables ??= doubleThreeTables();
  const codes = blocked.slice();
  function update(square, delta) {
    const link = links[square];
    for (let j = 0; j < link.length; j += 2) codes[link[j]] += delta * link[j + 1];
  }
  for (let square = 0; square < board.length; square++) if (board[square]) update(square, board[square]);
  function put(square, player) {
    update(square, player - board[square]);
    board[square] = player;
  }
  function isForbidden(r, c) {
    const square = idx(r, c);
    if (!inBounds(r, c) || board[square] !== 0) return false;
    const base = square * directions.length;
    let shapes = 0;
    for (let d = 0; d < directions.length; d++) if (extensions[codes[base + d]]) shapes++;
    if (shapes < 2 || winningLine(board, r, c, 1)) return false;
    put(square, 1);
    try {
      let legal = 0;
      for (let direction = 0; direction < directions.length; direction++) {
        const [dr, dc] = directions[direction];
        let mask = extensions[codes[base + direction]];
        while (mask) {
          const bit = 31 - Math.clz32(mask & -mask);
          const offset = offsets[bit];
          if (!isForbidden(r + offset * dr, c + offset * dc)) {
            if (++legal === 2) return true;
            break;
          }
          mask &= mask - 1;
        }
      }
      return false;
    } finally {
      put(square, 0);
    }
  }
  return { put, isForbidden };
}

// src/game/gomoku/logic.ts
var EMPTY = 0;
var BLACK = 1;
var WHITE = 2;
var opposite = (stone) => stone === BLACK ? WHITE : BLACK;
function checkWin(b, r, c, player) {
  const line = winningLine(b, r, c, player);
  return line ? { win: true, line } : { win: false };
}
function forbiddenMove(board, r, c, player, rule) {
  return rule === "double-three" && player === BLACK && isBlackDoubleThree(board, r, c);
}

// src/game/gomoku/tactics.ts
var directions2 = [[0, 1], [1, 0], [1, 1], [1, -1]];
var windows = Uint8Array.from(Array.from({ length: BOARD * BOARD }, (_, square) => {
  const r = Math.floor(square / BOARD), c = square % BOARD;
  return directions2.flatMap(([dr, dc]) => inBounds(r + 4 * dr, c + 4 * dc) ? Array.from({ length: 5 }, (_2, step) => idx(r + step * dr, c + step * dc)) : []);
}).flat());
function scan(board, attacker, includeFours) {
  const wins = /* @__PURE__ */ new Set(), opposingWins = /* @__PURE__ */ new Set(), fours = /* @__PURE__ */ new Set();
  let opposingFour = false;
  for (let i = 0; i < windows.length; i += 5) {
    let own = 0, opposing = 0, first = -1, second = -1;
    for (let j = i; j < i + 5; j++) {
      const square = windows[j], cell = board[square];
      if (cell === attacker) own++;
      else if (cell !== EMPTY) opposing++;
      else {
        second = first;
        first = square;
      }
    }
    if (opposing === 4 && own === 0) opposingWins.add(first);
    if (includeFours && opposing === 3 && own === 0) opposingFour = true;
    if (opposing !== 0) continue;
    if (own === 4) wins.add(first);
    if (includeFours && own === 3) {
      fours.add(first);
      fours.add(second);
    }
  }
  return { wins, opposingWins, fours, opposingFour };
}
function forbidden(index, square, player) {
  return player === BLACK && index?.isForbidden(Math.floor(square / BOARD), square % BOARD);
}
function makeSearchMove(board, index, square, player) {
  if (index) index.put(square, player);
  else board[square] = player;
}
function fourAttack(board, attacker, index, turns, deadline, threats = scan(board, attacker, turns > 0)) {
  if (performance.now() >= deadline) return void 0;
  const immediate = threats.wins.values().next().value;
  if (immediate !== void 0) return immediate;
  if (turns === 0 || threats.opposingWins.size > 1) return null;
  const defense = threats.opposingWins.values().next().value;
  const defender = attacker === BLACK ? 2 : BLACK;
  for (const square of threats.fours) {
    if (performance.now() >= deadline) return void 0;
    if (defense !== void 0 && defense !== square || forbidden(index, square, attacker)) continue;
    makeSearchMove(board, index, square, attacker);
    try {
      const attack = scan(board, attacker, false);
      if (attack.opposingWins.size > 0) continue;
      if (attack.wins.size > 1) return square;
      const block = attack.wins.values().next().value;
      if (block === void 0) continue;
      if (forbidden(index, block, defender)) return square;
      if (turns === 1) continue;
      makeSearchMove(board, index, block, defender);
      try {
        const continuation = fourAttack(board, attacker, index, turns - 1, deadline);
        if (continuation === void 0) return void 0;
        if (continuation !== null) return square;
      } finally {
        makeSearchMove(board, index, block, EMPTY);
      }
    } finally {
      makeSearchMove(board, index, square, EMPTY);
    }
  }
  return null;
}
function hasFourThreat(board, player) {
  const threats = scan(board, player, true);
  return threats.wins.size > 0 || threats.opposingWins.size > 0 || threats.fours.size > 0 || threats.opposingFour;
}
function reviewMove(board, move, player, rule, budget, rank) {
  const deadline = performance.now() + budget;
  const index = rule === "double-three" ? createDoubleThreeIndex(board) : void 0;
  const opponent = opposite(player);
  const danger = (r, c) => {
    const square = idx(r, c);
    makeSearchMove(board, index, square, player);
    try {
      if (checkWin(board, r, c, player).win) return null;
      return fourAttack(board, opponent, index, 5, deadline);
    } finally {
      makeSearchMove(board, index, square, EMPTY);
    }
  };
  if (typeof danger(move.r, move.c) !== "number") return move;
  const choices = [];
  for (let r = 0; r < BOARD; r++) {
    for (let c = 0; c < BOARD; c++) {
      const square = idx(r, c);
      if (board[square] !== EMPTY || r === move.r && c === move.c || forbidden(index, square, player)) continue;
      choices.push({ r, c, score: rank(r, c) });
    }
  }
  choices.sort((a, b) => b.score - a.score);
  for (const { r, c } of choices) {
    if (performance.now() >= deadline) break;
    const threat = danger(r, c);
    if (threat === void 0) break;
    if (threat === null) return { r, c, player };
  }
  return move;
}

// src/game/gomoku/ai.ts
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
function ttProbe(h1, h2, me, ply, depth, alpha, beta) {
  const hit = TT.get(hashKey(h1, h2) * 2 + (me - 1));
  if (!hit || hit.d < depth) return null;
  const score = hit.v > WIN - 100 ? hit.v - ply : hit.v < -WIN + 100 ? hit.v + ply : hit.v;
  if (hit.flag === TT_EXACT) return score;
  if (hit.flag === TT_LOWER && score >= beta) return score;
  if (hit.flag === TT_UPPER && score <= alpha) return score;
  return null;
}
function ttStore(h1, h2, me, ply, depth, flag, v) {
  if (TT.size > TT_LIMIT) TT.clear();
  const score = v > WIN - 100 ? v + ply : v < -WIN + 100 ? v - ply : v;
  TT.set(hashKey(h1, h2) * 2 + (me - 1), { d: depth, flag, v: score });
}
var other = (p) => p === BLACK ? WHITE : BLACK;
var FIVE_SCORE = 1e6;
var FOUR_SCORE = 12e3;
function gather(b, me, opp, style = "balanced", rule = "freestyle", doubleThree, defense) {
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
    const forbidden2 = checkForbidden && (doubleThree ? doubleThree.isForbidden(r, c) : forbiddenMove(b, r, c, BLACK, rule));
    if (forbidden2 && me === BLACK) {
      if (defense && pointScore(b, r, c, opp) >= FIVE_SCORE) defense.forbiddenWin = true;
      continue;
    }
    const atk = pointScore(b, r, c, me);
    const def = forbidden2 ? 0 : pointScore(b, r, c, opp);
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
function negamax(b, me, depth, alpha, beta, ply, h1, h2, ctx) {
  ctx.nodes++;
  if ((ctx.nodes & 127) === 0 && performance.now() > ctx.deadline) {
    ctx.abort = true;
    return 0;
  }
  const alphaOrig = alpha;
  const cached = ttProbe(h1, h2, me, ply, depth, alpha, beta);
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
  const defense = { forbiddenWin: false };
  const all = gather(b, me, opp, "balanced", ctx.rule, ctx.doubleThree, defense);
  if (all.length === 0) return ctx.rule === "double-three" && me === BLACK && b.includes(EMPTY) ? -WIN + ply : 0;
  const five = all.find((m) => m.atk >= FIVE_SCORE);
  if (five) return WIN - ply;
  const blocks = all.filter((m) => m.def >= FIVE_SCORE);
  let moves;
  let ext = 0;
  if (defense.forbiddenWin || blocks.length > 1) return -WIN + ply + 1;
  if (blocks.length === 1) {
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
    makeSearchMove(b, ctx.doubleThree, m.i, me);
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
    makeSearchMove(b, ctx.doubleThree, m.i, EMPTY);
    restoreCell(ply);
    if (ctx.abort) return 0;
    if (v > best) best = v;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  flag = best >= beta ? TT_LOWER : best > alphaOrig ? TT_EXACT : TT_UPPER;
  ttStore(h1, h2, me, ply, depth, flag, best);
  return best;
}
var previousEvaluation = "";
function iterativeDeepening(b, ai, maxDepth = 14, timeMs = 3e3, variant = 0, style = "balanced", rule = "freestyle", preferred) {
  const evaluation = `${rule}:${style === "balanced" ? style : `${style}-${ai}`}`;
  if (evaluation !== previousEvaluation) TT.clear();
  previousEvaluation = evaluation;
  const started = performance.now();
  const deadline = started + timeMs;
  const tactical = maxDepth >= 6;
  const ctx = {
    deadline: deadline - (tactical ? timeMs * 0.16 : 0),
    nodes: 0,
    abort: false,
    ai,
    style,
    rule,
    doubleThree: rule === "double-three" ? createDoubleThreeIndex(b) : void 0
  };
  const opp = other(ai);
  const defense = { forbiddenWin: false };
  const root = gather(b, ai, opp, style, rule, ctx.doubleThree, defense);
  if (root.length === 0) return { move: null, depth: 0, nodes: 0, score: 0 };
  const five = root.find((m) => m.atk >= FIVE_SCORE);
  if (five) return { move: { r: five.r, c: five.c, player: ai }, depth: 0, nodes: 1, score: WIN };
  const mustBlock = root.filter((m) => m.def >= FIVE_SCORE);
  if (mustBlock.length > 0) {
    mustBlock.sort((a, z) => z.score - a.score);
    const score = defense.forbiddenWin || mustBlock.length > 1 ? -WIN + 1 : 0;
    return { move: { r: mustBlock[0].r, c: mustBlock[0].c, player: ai }, depth: 0, nodes: 1, score };
  }
  if (defense.forbiddenWin) {
    const { r, c } = root.reduce((best2, candidate) => candidate.score > best2.score ? candidate : best2);
    return { move: { r, c, player: ai }, depth: 0, nodes: 1, score: -WIN + 1 };
  }
  if (tactical) {
    const attack = fourAttack(b, ai, ctx.doubleThree, 4, started + Math.min(timeMs * 0.14, 120));
    if (attack != null) {
      return { move: { r: Math.floor(attack / BOARD), c: attack % BOARD, player: ai }, depth: 0, nodes: 0, score: WIN };
    }
  }
  root.sort((a, z) => z.score - a.score);
  initEval(b);
  const top = root.slice(0, variant === 1 ? 10 : 12);
  const seed = root.find((move) => move.i === preferred);
  if (seed && !top.includes(seed)) top[top.length - 1] = seed;
  let best = seed ?? top[0];
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
  for (let d = 2; d <= maxDepth && performance.now() < ctx.deadline; d += 2) {
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
        makeSearchMove(b, ctx.doubleThree, m.i, ai);
        refreshCell(b, m.i);
        const { win } = checkWin(b, m.r, m.c, ai);
        let v;
        if (win) v = WIN;
        else if (k === 0) v = -negamax(b, opp, d - 1, -b0, -a, 1, zh1, zh2, ctx);
        else {
          v = -negamax(b, opp, d - 1, -a - 1, -a, 1, zh1, zh2, ctx);
          if (!ctx.abort && v > a && v < b0) v = -negamax(b, opp, d - 1, -b0, -a, 1, zh1, zh2, ctx);
        }
        makeSearchMove(b, ctx.doubleThree, m.i, EMPTY);
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
  if (tactical && bestScore < WIN - 100) {
    const dangerAfter = (candidate) => {
      makeSearchMove(b, ctx.doubleThree, candidate.i, ai);
      const threat = fourAttack(b, opp, ctx.doubleThree, 3, deadline);
      makeSearchMove(b, ctx.doubleThree, candidate.i, EMPTY);
      return threat;
    };
    if (typeof dangerAfter(best) === "number") {
      for (const alternative of root) {
        if (alternative === best) continue;
        if (performance.now() >= deadline) break;
        const threat = dangerAfter(alternative);
        if (threat === void 0) break;
        if (threat === null) {
          best = alternative;
          bestScore = 0;
          break;
        }
      }
    }
  }
  return { move: { r: best.r, c: best.c, player: ai }, depth: completed, nodes: ctx.nodes, score: bestScore };
}

// src/game/gomoku/endgame.ts
var ENDGAME_LIMIT = 10;
var MATE = 100;
function solveEndgame(board, turn, rule, budget = 220) {
  const blank = [];
  for (let i = 0; i < board.length; i++) if (board[i] === EMPTY) blank.push(i);
  if (blank.length > ENDGAME_LIMIT) return { kind: "too-many" };
  const weights2 = blank.map((_, i) => 3 ** i);
  const memo = /* @__PURE__ */ new Map();
  const deadline = performance.now() + budget;
  let root = null;
  function search(player, code, remaining) {
    if (remaining === 0) return 0;
    if (performance.now() >= deadline) return void 0;
    const key = code * 2 + player - 1;
    const cached = memo.get(key);
    if (cached !== void 0) return cached;
    let best = -MATE;
    for (let j = 0; j < blank.length; j++) {
      const square = blank[j], r = Math.floor(square / BOARD), c = square % BOARD;
      if (board[square] !== EMPTY || forbiddenMove(board, r, c, player, rule)) continue;
      board[square] = player;
      const child = checkWin(board, r, c, player).win ? -MATE : search(opposite(player), code + player * weights2[j], remaining - 1);
      board[square] = EMPTY;
      if (child === void 0) return void 0;
      const score2 = -child + Math.sign(child);
      if (score2 <= best) continue;
      best = score2;
      if (code === 0) root = { r, c, player };
      if (best === MATE - 1) break;
    }
    memo.set(key, best);
    return best;
  }
  const score = search(turn, 0, blank.length);
  if (score === void 0) return { kind: "timeout" };
  const plies = score === 0 ? null : MATE - Math.abs(score);
  const winner = score === 0 ? null : score > 0 ? turn : opposite(turn);
  const winnerMoves = plies === null ? null : Math.floor((plies + Number(turn === winner)) / 2);
  return { kind: "exact", winner, plies, winnerMoves, move: root };
}

// src/game/gomoku/ai-worker.ts
var scope = self;
scope.onmessage = ({ data }) => {
  if (data.kind === "solve") {
    const { token: token2, board: board2, player: player2, rule: rule2, timeMs: timeMs2 } = data;
    scope.postMessage({ kind: "solve", token: token2, result: solveEndgame(board2, player2, rule2, timeMs2) });
    return;
  }
  if (data.kind === "review") {
    const { token: token2, board: board2, player: player2, rule: rule2, timeMs: timeMs2 } = data;
    const start2 = performance.now();
    const exact = data.exact ? solveEndgame(board2, player2, rule2, timeMs2 * 0.55) : null;
    const move = exact?.kind === "exact" && exact.move ? exact.move : data.review ? defend(board2, data.move, player2, rule2, timeMs2 - (performance.now() - start2)) : data.move;
    scope.postMessage({ kind: "review", token: token2, move });
    return;
  }
  if (data.kind === "ponder") {
    const { token: token2, board: board2, opponent, ai: ai2, rule: rule2, local } = data;
    const prediction = iterativeDeepening(board2, opponent, 2, 40, 0, "balanced", rule2).move;
    let reply = null;
    if (prediction && local) {
      const square = idx(prediction.r, prediction.c);
      board2[square] = opponent;
      if (!checkWin(board2, prediction.r, prediction.c, opponent).win && board2.includes(EMPTY)) {
        reply = iterativeDeepening(board2, ai2, 8, 245, 0, "balanced", rule2).move;
      }
    }
    scope.postMessage({ kind: "ponder", token: token2, prediction, reply });
    return;
  }
  const { token, ai, maxDepth, timeMs, variant, style, rule = "freestyle", preferred } = data;
  const board = Uint8Array.from(data.board);
  const start = performance.now();
  const player = ai;
  if (data.exact) {
    const exact = solveEndgame(board, player, rule, timeMs * 0.25);
    if (exact.kind === "exact") {
      scope.postMessage({ kind: "search", token, move: exact.move, depth: 0, score: 0, nodes: 0 });
      return;
    }
  }
  const reserve = data.review && hasFourThreat(board, player) ? Math.min(210, timeMs * 0.18) : 0;
  const remaining = Math.max(1, timeMs - reserve - (performance.now() - start));
  const res = iterativeDeepening(board, ai, maxDepth, remaining, variant | 0, style, rule, preferred);
  if (res.move && reserve && performance.now() - start < timeMs) {
    res.move = defend(board, res.move, player, rule, timeMs - (performance.now() - start));
  }
  scope.postMessage({ kind: "search", token, ...res });
};
function defend(board, move, player, rule, timeMs) {
  const opponent = opposite(player);
  return reviewMove(
    board,
    move,
    player,
    rule,
    timeMs,
    (r, c) => pointScore(board, r, c, player) + pointScore(board, r, c, opponent)
  );
}
