/**
 * ai-worker.ts — 高手难度后台搜索线程（可多实例并行，variant 差异化策略）。
 * 主线程把棋盘快照发过来，这里跑 VCF 证明 + 迭代加深搜索，回传带 token 的结果；
 * token 不匹配的结果（悔棋/重开/返回标题后到达）由主线程丢弃。
 */

import { iterativeDeepening } from "./ai";
import { EMPTY, checkWin, idx, type Cell, type Move, type Rule, type Stone } from "./logic";
import { solveEndgame, type EndgameResult } from "./endgame";
import { hasPressure } from "./tactics";
import { reviewMasterMove } from "./master";
import type { Style } from "./match";

interface SearchRequest {
  kind?: "search";
  token: number;
  board: ArrayLike<number>;
  ai: Cell;
  maxDepth: number;
  timeMs: number;
  variant: number;
  style?: Style;
  rule?: Rule;
  preferred?: number;
  review?: boolean;
  exact?: boolean;
  deep?: boolean;
  arena?: boolean;
}

interface PonderRequest {
  kind: "ponder";
  token: number;
  board: Uint8Array;
  opponent: Cell;
  ai: Cell;
  rule: Rule;
  local: boolean;
}

interface AnalysisRequest {
  token: number;
  board: Uint8Array;
  player: Stone;
  rule: Rule;
  timeMs: number;
}

export type AiWorkerRequest = SearchRequest | PonderRequest
  | (AnalysisRequest & { kind: "solve" })
  | (AnalysisRequest & { kind: "review"; move: Move; alternatives?: Move[]; exact: boolean; review: boolean; arena?: boolean });

interface SearchReply {
  kind: "search";
  token: number;
  move: Move | null;
  depth: number;
  nodes: number;
  score: number;
}

export type AiWorkerReply = SearchReply | { kind: "solve"; token: number; result: EndgameResult }
  | { kind: "review"; token: number; move: Move } | {
  kind: "ponder";
  token: number;
  prediction: Move | null;
  reply: Move | null;
};

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<AiWorkerRequest>) => void) | null;
  postMessage: (msg: AiWorkerReply) => void;
};

scope.onmessage = ({ data }) => {
  if (data.kind === "solve") {
    const { token, board, player, rule, timeMs } = data;
    scope.postMessage({ kind: "solve", token, result: solveEndgame(board, player, rule, timeMs) });
    return;
  }
  if (data.kind === "review") {
    const { token, board, player, rule, timeMs } = data;
    const start = performance.now();
    const exact = data.exact ? solveEndgame(board, player, rule, timeMs * 0.55) : null;
    const move = exact?.kind === "exact" && exact.move ? exact.move :
      data.review ? reviewMasterMove(board, data.move, data.alternatives ?? [], player, rule, timeMs - (performance.now() - start), data.arena) : data.move;
    scope.postMessage({ kind: "review", token, move });
    return;
  }
  if (data.kind === "ponder") {
    const { token, board, opponent, ai, rule, local } = data;
    const prediction = iterativeDeepening(board, opponent, 2, 40, 0, "balanced", rule).move;
    let reply = null;
    if (prediction && local) {
      const square = idx(prediction.r, prediction.c);
      board[square] = opponent;
      if (!checkWin(board, prediction.r, prediction.c, opponent).win && board.includes(EMPTY)) {
        reply = iterativeDeepening(board, ai, 8, 245, 0, "balanced", rule).move;
      }
    }
    scope.postMessage({ kind: "ponder", token, prediction, reply });
    return;
  }
  const { token, ai, maxDepth, timeMs, variant, style, rule = "freestyle", preferred } = data;
  const board = Uint8Array.from(data.board);
  const start = performance.now();
  const player = ai as Stone;
  if (data.exact) {
    const exact = solveEndgame(board, player, rule, timeMs * 0.25);
    if (exact.kind === "exact") {
      scope.postMessage({ kind: "search", token, move: exact.move, depth: 0, score: 0, nodes: 0 });
      return;
    }
  }
  const reserve = data.review && hasPressure(board, player)
    ? Math.min(data.arena ? 1250 : data.deep ? 510 : 240, timeMs * (data.arena ? 0.25 : 0.19)) : 0;
  const remaining = Math.max(1, timeMs - reserve - (performance.now() - start));
  const res = iterativeDeepening(board, ai, maxDepth, remaining, variant | 0, style, rule, preferred, reserve > 0);
  if (res.move && reserve && performance.now() - start < timeMs) {
    res.move = reviewMasterMove(board, res.move, res.alternatives ?? [], player, rule, timeMs - (performance.now() - start), data.arena);
  }
  scope.postMessage({ kind: "search", token, ...res });
};

export {};
