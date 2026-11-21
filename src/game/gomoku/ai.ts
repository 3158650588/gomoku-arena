/**
 * ai.ts — 五子棋引擎（纯计算，无渲染依赖，可跑在主线程或 Worker）。
 *
 * 强度来源：
 *  - 棋形匹配评估：按整条线扫描五连/活四/冲四/活三/眠三/活二/眠二全套棋形
 *  - Zobrist 哈希 + 置换表（EXACT/LOWER/UPPER 界）
 *  - 迭代加深 PVS（主变搜索）+ aspiration 窗口
 *  - 四威胁延伸：存在冲四/活四时强制 deepen（近似 VCF 强制手推演）
 *  - 必走剪枝：己方成五必走；对手有成五点时只搜阻挡手
 */

import { BOARD, BLACK, WHITE, EMPTY, Board, Cell, idx, inBounds, checkWin, forbiddenMove, Move, type Rule } from "./logic";
import type { Style } from "./match";
import { createDoubleThreeIndex, type DoubleThreeIndex } from "../../../scripts/board-rules.mjs";
import { fourAttack, makeSearchMove } from "./tactics";

export const DIFFICULTIES = ["easy", "beginner", "normal", "advanced", "expert", "hard"] as const;
export type Difficulty = typeof DIFFICULTIES[number];

export const RAPFI_LEVELS = {
  expert: { maxDepth: 2, timeMs: 500, strength: 10 },
  hard: { maxDepth: 99, timeMs: 3500 },
} as const;

export function usesRapfi(difficulty: Difficulty): difficulty is keyof typeof RAPFI_LEVELS {
  return difficulty === "expert" || difficulty === "hard";
}

const INF = 1e15;
const WIN = 1e9;

/* ---------- 棋形评估表（数字编码查表，无正则无字符串分配） ---------- */

const VAL_FIVE = 1_000_000;
const VAL_LIVE4 = 100_000;
const VAL_RUSH4 = 12_000;
const VAL_LIVE3 = 8_000;
const VAL_SLEEP3 = 1_000;
const VAL_LIVE2 = 600;
const VAL_SLEEP2 = 150;

/**
 * 为一方构建棋形码表。X=己方棋子，O=对方棋子，0=空位。
 * 完全复刻 v2 正则评估的棋形清单与计数语义：
 *  - 每个棋形类独立计数（等价于每类一条 /g 正则）：同类不重叠、跨类可叠加，
 *    连通阵型中多个弱棋形与强棋形共存时全部计入（v3 的"每线只取最强"会丢分）。
 *  - 无边界校验位：v2 不校验相邻格，边界处由填充格（对方棋子）自然堵住。
 * 表项布局：低 24 位分值 | 棋形类编号（1..7）<< 24。
 */
function buildTable(side: "1" | "2"): Uint32Array {
  const o = side === "1" ? "2" : "1";
  const defs: Array<[string[], number, number]> = [
    [["XXXXX"], VAL_FIVE, 1],
    [["0XXXX0"], VAL_LIVE4, 2],
    [["XXXX0O", "O0XXXX", "XXXXO", "OXXXX", "XX0XX", "X0XXX", "XXX0X"], VAL_RUSH4, 3],
    [["0XXX00", "00XXX0", "0X0XX0", "0XX0X0"], VAL_LIVE3, 4],
    [
      [
        "OXXX00", "00XXXO", "XXX00O", "O00XXX", // 一头堵死的三
        "X0XXO", "OXX0X", "XX0XO", "OX0XX", // 断点三
        "XO0X0", "0X0OX", "0XOX0", "X0XO0", "0X0XO", // 间隔三
      ],
      VAL_SLEEP3,
      5,
    ],
    [["00XX00", "0X0X00", "00X0X0", "0X00X0", "0XX00", "00XX0"], VAL_LIVE2, 6],
    [
      [
        "OXX000", "000XXO", "O0XX00", "00XX0O", // 一头堵住的二
        "X0X000", "000X0X", "X00X00", "00X00X", // 断点二
        "O0X0X0", "0X0X0O", "XO00X0", "0X00OX", // 特殊间隔二
      ],
      VAL_SLEEP2,
      7,
    ],
  ];
  const map = new Uint32Array(32768);
  for (const [shapes, v, cls] of defs) {
    for (const raw of shapes) {
      const s = raw.replace(/X/g, side).replace(/O/g, o);
      let code = 0;
      for (let i = 0; i < s.length; i++) code = code * 3 + (s.charCodeAt(i) - 48);
      map[code + s.length * 4096] = v | (cls << 24);
    }
  }
  return map;
}

const TAB_SIDE = [buildTable("1"), buildTable("2")]; // Uint32Array 直接寻址（0 表示无此棋形）

const lineBuf = new Int8Array(BOARD + 2);

/** 每类棋形的独立游标（同类不重叠的 /g 正则语义），scanLine 开始时清零。 */
const clsCur = new Int32Array(8);

/**
 * 单遍扫描 buf[0,len)，数值化复刻 v2 的 scoreLine（/g 正则计数）：
 * 每个位置先试 6 格再试 5 格（对应正则中贪婪的可选空位），命中则按棋形类
 * 独立提交并推进该类游标；同类重叠只计首个（/g 不重叠），跨类各自计数。
 * buf 两端需按被扫描方的视角预先填充「对方棋子」（边界视为堵住）。
 */
function scanLine(tab: Uint32Array, len: number): number {
  const buf = lineBuf;
  const cur = clsCur;
  cur.fill(0);
  let sc = 0;
  for (let i = 0; i < len; i++) {
    if (i + 6 <= len) {
      const code6 =
        (((((buf[i] * 3 + buf[i + 1]) * 3 + buf[i + 2]) * 3 + buf[i + 3]) * 3 + buf[i + 4]) * 3 +
        buf[i + 5]) | 0;
      let e = tab[code6 + 24576];
      if (e !== 0) {
        const cls = e >>> 24;
        if (i >= cur[cls]) {
          sc += e & 0xffffff;
          cur[cls] = i + 6;
        }
      }
      e = tab[((code6 / 3) | 0) + 20480];
      if (e !== 0) {
        const cls = e >>> 24;
        if (i >= cur[cls]) {
          sc += e & 0xffffff;
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
          sc += e & 0xffffff;
          cur[cls] = i + 5;
        }
      }
    }
  }
  return sc;
}

/** 扫描一条线：我方棋形分 − 对手棋形分×1.08（两端按各方视角填对方子）。 */
function evalLine(tabMe: Uint32Array, tabOpp: Uint32Array, len: number, padMe: number, padOpp: number): number {
  lineBuf[0] = padMe;
  lineBuf[len - 1] = padMe;
  const a = scanLine(tabMe, len);
  lineBuf[0] = padOpp;
  lineBuf[len - 1] = padOpp;
  const b = scanLine(tabOpp, len);
  return a - Math.round(b * 1.08);
}

/** 局面静态评估（AI 视角；对手棋形略加权体现防守倾向）。 */
export function evalBoard(b: Board, ai: Cell): number {
  const tabMe = TAB_SIDE[ai - 1];
  const tabOpp = TAB_SIDE[ai === BLACK ? 1 : 0];
  const padMe = ai === BLACK ? 2 : 1; // 我方视角：边界视为对方棋子
  const padOpp = ai;
  const N = BOARD;
  let score = 0;
  // 水平 / 垂直
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) lineBuf[c + 1] = b[idx(r, c)];
    score += evalLine(tabMe, tabOpp, N + 2, padMe, padOpp);
  }
  for (let c = 0; c < N; c++) {
    for (let r = 0; r < N; r++) lineBuf[r + 1] = b[idx(r, c)];
    score += evalLine(tabMe, tabOpp, N + 2, padMe, padOpp);
  }
  // 主斜线（c = r - s）
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
  // 副斜线（c = s - r）
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

/* ---------- 增量评估（搜索树内只重算过子线） ---------- */

interface LineDef {
  cells: Uint8Array;
}

/** 全盘 72 条线（15 行 + 15 列 + 21 主斜 + 21 副斜，均 ≥5 格）。 */
const LINES: LineDef[] = (() => {
  const out: LineDef[] = [];
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
    const cells: number[] = [];
    for (let r = 0; r < N; r++) {
      const c = r - s;
      if (c >= 0 && c < N) cells.push(idx(r, c));
    }
    if (cells.length >= 5) out.push({ cells: Uint8Array.from(cells) });
  }
  for (let s = 4; s <= 2 * N - 6; s++) {
    const cells: number[] = [];
    for (let r = 0; r < N; r++) {
      const c = s - r;
      if (c >= 0 && c < N) cells.push(idx(r, c));
    }
    if (cells.length >= 5) out.push({ cells: Uint8Array.from(cells) });
  }
  return out;
})();

const LINE_COUNT = LINES.length;

/** 每个格子所属的线 id（≤4 条）。 */
const CELL_LINES: Uint8Array[] = (() => {
  const lists: number[][] = Array.from({ length: BOARD * BOARD }, () => []);
  for (let lid = 0; lid < LINE_COUNT; lid++) {
    for (const cell of LINES[lid].cells) lists[cell].push(lid);
  }
  return lists.map((l) => Uint8Array.from(l));
})();

/** 每条线黑白两方的棋形分（随落子/提子重算）。 */
const lineVal1 = new Int32Array(LINE_COUNT);
const lineVal2 = new Int32Array(LINE_COUNT);
let tot1 = 0;
let tot2 = 0;
/** 加权和 Σ round(线分×1.08)：使增量评估与 evalBoard 的逐线取整逐位一致。 */
let totW1 = 0;
let totW2 = 0;

/** 撤销快照：negamax 每层只落一子，记下其穿过线的旧值，提子时整体恢复。 */
const snapCell = new Int32Array(40);
const snapT1 = new Int32Array(40);
const snapT2 = new Int32Array(40);
const snapW1 = new Int32Array(40);
const snapW2 = new Int32Array(40);
const snapVals = new Int32Array(40 * 8);

function snapshotCell(ply: number, i: number): void {
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

function restoreCell(ply: number): void {
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

/** 重算一条线的双方棋形分并同步总分（两端按各方视角填对方子）。 */
function refreshLine(b: Board, lid: number): void {
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

/** 落子或提子后，刷新该格穿过的所有线。搜索树内 b 的每次变动都要调用。 */
function refreshCell(b: Board, i: number): void {
  for (const lid of CELL_LINES[i]) refreshLine(b, lid);
}

/** 以根局面初始化增量评估状态（每次迭代加深开始时调用一次）。 */
function initEval(b: Board): void {
  lineVal1.fill(0);
  lineVal2.fill(0);
  tot1 = 0;
  tot2 = 0;
  totW1 = 0;
  totW2 = 0;
  for (let lid = 0; lid < LINE_COUNT; lid++) refreshLine(b, lid);
}

/** 基于增量总分、按行棋方视角返回评估值（叶子节点 O(1)，与 evalBoard 逐位一致）。 */
function evalFast(me: Cell): number {
  return me === BLACK ? tot1 - totW2 : tot2 - totW1;
}

/* ---------- 连子表（用于招法排序的快速启发） ---------- */

function patternScore(count: number, open: number): number {
  if (count >= 5) return 1_000_000;
  if (count === 4) return open === 2 ? 100_000 : open === 1 ? 12_000 : 0;
  if (count === 3) return open === 2 ? 8_000 : open === 1 ? 1_000 : 0;
  if (count === 2) return open === 2 ? 600 : open === 1 ? 150 : 0;
  return open === 2 ? 40 : 0;
}

const DIRS: ReadonlyArray<readonly [number, number]> = [[0, 1], [1, 0], [1, 1], [1, -1]];

/** 若 (r,c) 落 player 子，四个方向棋型分之和（供招法排序）。 */
export function pointScore(b: Board, r: number, c: number, player: Cell): number {
  let total = 0;
  for (const [dr, dc] of DIRS) {
    let count = 1;
    let open = 0;
    let rr = r + dr, cc = c + dc;
    while (inBounds(rr, cc) && b[idx(rr, cc)] === player) { count++; rr += dr; cc += dc; }
    if (inBounds(rr, cc) && b[idx(rr, cc)] === EMPTY) open++;
    rr = r - dr; cc = c - dc;
    while (inBounds(rr, cc) && b[idx(rr, cc)] === player) { count++; rr -= dr; cc -= dc; }
    if (inBounds(rr, cc) && b[idx(rr, cc)] === EMPTY) open++;
    total += patternScore(count, open);
  }
  return total;
}

/** 候选点：已有棋子切比雪夫距离 2 以内的空位。 */
/** 复用 scratch：nearMask[i]=1 表示 i 是「距某子切比雪夫距离 ≤2 的空位」；
 *  near1Mask[i]=1 表示距离 ≤1（战术点：成五/成四/挡点必在此集合内）；
 *  nbrCnt[i] 表示 i 的 8 邻域棋子数（供距离 2 安静点粗略排序）。 */
const nearMask = new Uint8Array(BOARD * BOARD);
const near1Mask = new Uint8Array(BOARD * BOARD);
const nbrCnt = new Uint8Array(BOARD * BOARD);

/** 填充上述三个 scratch，返回棋盘上的棋子数（0 表示空盘）。 */
function fillNear(b: Board): number {
  nearMask.fill(0);
  near1Mask.fill(0);
  nbrCnt.fill(0);
  let stones = 0;
  for (let i = 0; i < b.length; i++) {
    if (b[i] === EMPTY) continue;
    stones++;
    const r = (i / BOARD) | 0, c = i % BOARD;
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

/** 全量候选（空盘返回天元）。仅用于 bestMove 的 easy 档等低频路径。 */
export function candidates(b: Board): [number, number][] {
  if (fillNear(b) === 0) return [[7, 7]];
  const out: [number, number][] = [];
  for (let i = 0; i < b.length; i++) if (nearMask[i]) out.push([(i / BOARD) | 0, i % BOARD]);
  return out;
}

/* ---------- Zobrist 哈希（48 位） ---------- */

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(0x5d5);
const Z1 = new Uint32Array(BOARD * BOARD * 2);
const Z2 = new Uint32Array(BOARD * BOARD * 2);
for (let i = 0; i < Z1.length; i++) {
  Z1[i] = (rnd() * 0xffffffff) >>> 0;
  Z2[i] = (rnd() * 0xffffffff) >>> 0;
}
function hashKey(h1: number, h2: number): number {
  return (h1 >>> 0) * 0x10000 + (h2 & 0xffff);
}

/* ---------- 置换表 ---------- */

const TT_EXACT = 0, TT_LOWER = 1, TT_UPPER = 2;
const TT = new Map<number, { d: number; flag: number; v: number }>();
const TT_LIMIT = 600_000;

function ttProbe(h1: number, h2: number, me: Cell, ply: number, depth: number, alpha: number, beta: number): number | null {
  const hit = TT.get(hashKey(h1, h2) * 2 + (me - 1));
  if (!hit || hit.d < depth) return null;
  const score = hit.v > WIN - 100 ? hit.v - ply : hit.v < -WIN + 100 ? hit.v + ply : hit.v;
  if (hit.flag === TT_EXACT) return score;
  if (hit.flag === TT_LOWER && score >= beta) return score;
  if (hit.flag === TT_UPPER && score <= alpha) return score;
  return null;
}

function ttStore(h1: number, h2: number, me: Cell, ply: number, depth: number, flag: number, v: number): void {
  if (TT.size > TT_LIMIT) TT.clear();
  const score = v > WIN - 100 ? v + ply : v < -WIN + 100 ? v - ply : v;
  TT.set(hashKey(h1, h2) * 2 + (me - 1), { d: depth, flag, v: score });
}

const other = (p: Cell): Cell => (p === BLACK ? WHITE : BLACK);

/* ---------- PVS + 四威胁延伸 ---------- */

interface Ctx {
  deadline: number;
  nodes: number;
  abort: boolean;
  ai: Cell;
  style: Style;
  rule: Rule;
  checkCounter: boolean;
  doubleThree?: DoubleThreeIndex;
}

const FIVE_SCORE = 1_000_000; // 连子表中的成五分
const FOUR_SCORE = 12_000; // 冲四分（含活四下限）：存在即算"强制手局面"

interface Cand {
  r: number;
  c: number;
  i: number;
  atk: number;
  def: number;
  score: number;
}

function gather(
  b: Board, me: Cell, opp: Cell, style: Style = "balanced", rule: Rule = "freestyle",
  doubleThree?: DoubleThreeIndex, defense?: { forbiddenWin: boolean },
): Cand[] {
  const stones = fillNear(b);
  if (stones === 0) {
    const i = idx(7, 7); // 空盘：唯一天元候选
    return [{ r: 7, c: 7, i, atk: 0, def: 0, score: 1 }];
  }
  // 与 v2 一致：所有候选（含距离 2 的安静点）都精确计算双方棋型分，
  // 避免粗略打分把有潜力的安静手挤出 top-N。
  const list: Cand[] = [];
  const checkForbidden = rule === "double-three" && stones >= 4;
  for (let i = 0; i < b.length; i++) {
    if (!nearMask[i]) continue;
    const r = (i / BOARD) | 0, c = i % BOARD;
    const forbidden = checkForbidden && (doubleThree ? doubleThree.isForbidden(r, c) : forbiddenMove(b, r, c, BLACK, rule));
    if (forbidden && me === BLACK) {
      if (defense && pointScore(b, r, c, opp) >= FIVE_SCORE) defense.forbiddenWin = true;
      continue;
    }
    const atk = pointScore(b, r, c, me);
    const def = forbidden ? 0 : pointScore(b, r, c, opp);
    let score: number;
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

export function moveHints(board: Board, player: Cell, rule: Rule = "freestyle") {
  const ranked = gather(board, player, other(player), "balanced", rule).sort((a, b) => b.score - a.score);
  const first = ranked[0];
  if (!first) return null;
  const mustWin = first.atk >= FIVE_SCORE;
  const mustBlock = !mustWin && first.def >= FIVE_SCORE;
  const choices = mustWin ? ranked.filter((move) => move.atk >= FIVE_SCORE) :
    mustBlock ? ranked.filter((move) => move.def >= FIVE_SCORE) : ranked;
  const recommendation = mustWin || mustBlock ? first : bestMove(board, player, "normal", Math.random, "balanced", rule) ?? first;
  const candidates = [recommendation, ...choices.filter(
    (move) => move.r !== recommendation.r || move.c !== recommendation.c,
  )].slice(0, 3).map(({ r, c }) => ({ r, c, player }));
  const vertical = ["上", "中", "下"][Math.floor(recommendation.r / 5)];
  const horizontal = ["左", "中", "右"][Math.floor(recommendation.c / 5)];
  const area = vertical === horizontal ? "中腹" : `${horizontal}${vertical}`;
  return { candidates, area, urgency: mustWin ? "win" : mustBlock || first.def >= FOUR_SCORE ? "defense" : "position" };
}

/** Prefer one side's patterns among competitive Rapfi candidates. */
export function stylePreferences(board: Board, player: Cell, style: Style): number[] | null {
  if (style === "balanced") return null;
  const ranked = gather(board, player, other(player), style);
  if (ranked.some(({ atk, def }) => atk >= FIVE_SCORE || def >= FIVE_SCORE)) return null;
  const values = Array<number>(board.length).fill(0);
  for (const { i, atk, def } of ranked) {
    const attack = Math.log1p(atk);
    const defense = Math.log1p(def);
    values[i] = Math.round(24 * (style === "attack" ? attack - 0.7 * defense : defense - 0.7 * attack));
  }
  return values;
}

function negamax(
  b: Board,
  me: Cell,
  depth: number,
  alpha: number,
  beta: number,
  ply: number,
  h1: number,
  h2: number,
  ctx: Ctx,
): number {
  ctx.nodes++;
  if ((ctx.nodes & 127) === 0 && performance.now() > ctx.deadline) {
    ctx.abort = true;
    return 0;
  }

  const alphaOrig = alpha;
  const cached = ttProbe(h1, h2, me, ply, depth, alpha, beta);
  if (cached !== null) return cached;

  // 评估必须基于「当前行棋方」视角（标准 negamax）：强制延伸会改变
  // 根到叶子路径的奇偶性，用固定根视角会导致符号错乱。
  if (depth <= 0) {
    if (ctx.checkCounter && hasWinningPoint(b, me)) return WIN - ply;
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

  // 己方一手成五，直接胜
  const five = all.find((m) => m.atk >= FIVE_SCORE);
  if (five) return WIN - ply;

  // 对手有成五点：只搜阻挡手
  const blocks = all.filter((m) => m.def >= FIVE_SCORE);
  let moves: Cand[];
  let ext = 0;
  if (defense.forbiddenWin || blocks.length > 1) return -WIN + ply + 1;
  if (blocks.length === 1) {
    moves = blocks;
  } else {
    all.sort((a, z) => z.score - a.score);
    // VCF 式强制手：存在冲四/活四手段时只沿强制手推演并延伸两层
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
    let v: number;
    if (win) {
      v = WIN - ply;
    } else if (k === 0) {
      v = -negamax(b, opp, childDepth, -beta, -alpha, ply + 1, zh1, zh2, ctx);
    } else {
      // PVS：零窗口探测，命中再全窗口重搜
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

function hasWinningPoint(board: Board, player: Cell) {
  const total = player === BLACK ? tot1 : tot2;
  if (total < VAL_RUSH4) return false;
  const lines = player === BLACK ? lineVal1 : lineVal2;
  for (let lid = 0; lid < lines.length; lid++) {
    if (lines[lid] < VAL_RUSH4) continue;
    const cells = LINES[lid].cells;
    for (let start = 0; start + 5 <= cells.length; start++) {
      let stones = 0, empty = 0;
      for (let j = start; j < start + 5; j++) {
        const cell = board[cells[j]];
        if (cell === player) stones++;
        if (cell === EMPTY) empty++;
      }
      if (stones === 4 && empty === 1) return true;
    }
  }
  return false;
}

/* ---------- 迭代加深 ---------- */

export interface SearchResult {
  move: Move | null;
  depth: number;
  nodes: number;
  score: number;
  alternatives?: Move[];
}

/**
 * 迭代加深 PVS 搜索。timeMs 用完时返回上一完整深度的最佳手。
 * variant 用于多线程并行时的策略差异化（0 标准，1 变体：窄根窗口、无 aspiration）。
 */
let previousEvaluation = "";

export function iterativeDeepening(b: Board, ai: Cell, maxDepth = 14, timeMs = 3000, variant = 0, style: Style = "balanced", rule: Rule = "freestyle", preferred?: number, collectAlternatives = false, allowed?: ReadonlySet<number>): SearchResult {
  const evaluation = `${rule}:${style === "balanced" ? style : `${style}-${ai}`}:${Number(collectAlternatives)}`;
  if (evaluation !== previousEvaluation) TT.clear();
  previousEvaluation = evaluation;
  const started = performance.now();
  const deadline = started + timeMs;
  const tactical = maxDepth >= 6;
  const ctx: Ctx = { deadline: deadline - (tactical ? timeMs * 0.16 : 0), nodes: 0, abort: false, ai, style, rule,
    checkCounter: collectAlternatives,
    doubleThree: rule === "double-three" ? createDoubleThreeIndex(b) : undefined };
  const opp = other(ai);
  const defense = { forbiddenWin: false };
  const legal = gather(b, ai, opp, style, rule, ctx.doubleThree, defense);
  const root = allowed ? legal.filter(({ i }) => allowed.has(i)) : legal;
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
    const { r, c } = root.reduce((best, candidate) => candidate.score > best.score ? candidate : best);
    return { move: { r, c, player: ai }, depth: 0, nodes: 1, score: -WIN + 1 };
  }

  if (tactical) {
    const attack = fourAttack(b, ai, ctx.doubleThree, 4, started + Math.min(timeMs * 0.14, 120));
    if (attack != null && (!allowed || allowed.has(attack))) {
      return { move: { r: Math.floor(attack / BOARD), c: attack % BOARD, player: ai }, depth: 0, nodes: 0, score: WIN };
    }
  }

  root.sort((a, z) => z.score - a.score);
  initEval(b);
  const top = root.slice(0, variant === 1 ? 10 : 12);
  const seed = root.find((move) => move.i === preferred);
  if (seed && !top.includes(seed)) top[top.length - 1] = seed;
  let best: Cand = seed ?? top[0];
  let bestScore = 0;
  let completed = 0;
  let alternatives = top.slice(0, 4);

  let h1 = 0, h2 = 0;
  for (let i = 0; i < b.length; i++) {
    const v = b[i];
    if (v !== EMPTY) {
      h1 ^= Z1[i * 2 + (v - 1)];
      h2 ^= Z2[i * 2 + (v - 1)];
    }
  }

  const ASPIRATION = 60_000;
  for (let d = 2; d <= maxDepth && performance.now() < ctx.deadline; d += 2) {
    const ordered = [best, ...top.filter((m) => m !== best)];
    let alpha = completed > 0 && variant === 0 ? bestScore - ASPIRATION : -INF;
    let beta = completed > 0 && variant === 0 ? bestScore + ASPIRATION : INF;

    const searchOnce = (a0: number, b0: number) => {
      let iterBest: Cand | null = null;
      const scores: { move: Cand; score: number }[] = [];
      let a = a0;
      for (let k = 0; k < ordered.length; k++) {
        const m = ordered[k];
        const zh1 = h1 ^ Z1[m.i * 2 + (ai - 1)];
        const zh2 = h2 ^ Z2[m.i * 2 + (ai - 1)];
        makeSearchMove(b, ctx.doubleThree, m.i, ai);
        refreshCell(b, m.i);
        const { win } = checkWin(b, m.r, m.c, ai);
        let v: number;
        if (win) v = WIN;
        else if (k === 0) v = -negamax(b, opp, d - 1, -b0, -a, 1, zh1, zh2, ctx);
        else {
          v = -negamax(b, opp, d - 1, -a - 1, -a, 1, zh1, zh2, ctx);
          if (!ctx.abort && v > a && v < b0) v = -negamax(b, opp, d - 1, -b0, -a, 1, zh1, zh2, ctx);
        }
        makeSearchMove(b, ctx.doubleThree, m.i, EMPTY);
        refreshCell(b, m.i);
        if (ctx.abort) break;
        if (collectAlternatives) scores.push({ move: m, score: v });
        if (iterBest === null || v > a) {
          a = Math.max(a, v);
          iterBest = m;
        }
      }
      return { m: iterBest, v: a, scores };
    };

    let { m: iterBest, v: score, scores } = searchOnce(alpha, beta);
    if (!ctx.abort && completed > 0 && variant === 0 && (score <= alpha || score >= beta)) {
      // aspiration 失败：全窗口重搜
      ({ m: iterBest, v: score, scores } = searchOnce(-INF, INF));
    }
    if (ctx.abort || !iterBest) break;
    best = iterBest;
    bestScore = score;
    completed = d;
    if (collectAlternatives) alternatives = scores.sort((a, b) => b.score - a.score).slice(0, 4).map(({ move }) => move);
  }

  if (tactical && bestScore < WIN - 100) {
    const dangerAfter = (candidate: Cand) => {
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
        if (threat === undefined) break;
        if (threat === null) {
          best = alternative;
          bestScore = 0;
          break;
        }
      }
    }
  }
  return { move: { r: best.r, c: best.c, player: ai }, depth: completed, nodes: ctx.nodes, score: bestScore,
    ...(collectAlternatives && { alternatives: alternatives.map(({ r, c }) => ({ r, c, player: ai })) }) };

}

/* ---------- 难度入口 ---------- */

/** 本地启发式档位，以及 Rapfi 不可用时的同步入口。 */
export function bestMove(b: Board, ai: Cell, difficulty: Difficulty, rand: () => number = Math.random, style: Style = "balanced", rule: Rule = "freestyle"): Move | null {
  if (difficulty === "easy" || difficulty === "beginner") {
    const ranked = gather(b, ai, other(ai), style, rule).sort((a, z) => z.score - a.score);
    const best = ranked[0];
    if (!best) return null;
    // Both entry levels take immediate wins and blocks. Easy varies quieter moves.
    const pick = difficulty === "easy" && best.atk < FIVE_SCORE && best.def < FIVE_SCORE && rand() < 0.34
      ? ranked[1] ?? best
      : best;
    return { r: pick.r, c: pick.c, player: ai };
  }

  if (difficulty === "normal") {
    const res = iterativeDeepening(b, ai, 2, 500, 0, style, rule);
    return res.move;
  }

  if (difficulty === "advanced" || difficulty === "expert") {
    return iterativeDeepening(b, ai, 6, 240, 0, style, rule).move;
  }

  const res = iterativeDeepening(b, ai, 12, 2500, 0, style, rule);
  return res.move;
}
