import { BOARD, checkWin, createBoard, forbiddenMove, idx, opposite, type Rule } from "./logic";
import { readPosition, type SavedMatch } from "./match";
import { proveFourAttack } from "./tactics";

export function firstReplayBan(match: SavedMatch): number | null {
  const board = createBoard();
  for (const { r, c, player } of match.setup.initial?.stones ?? []) board[idx(r, c)] = player;
  for (let ply = 0; ply < match.moves.length; ply++) {
    const { r, c, player } = match.moves[ply];
    if (forbiddenMove(board, r, c, player, "double-three")) return ply;
    board[idx(r, c)] = player;
  }
  return null;
}

export function defeatLesson(match: SavedMatch) {
  const defender = match.setup.playerColor;
  const attacker = opposite(defender);
  const rule: Rule = match.setup.rule ?? "freestyle";
  if (match.setup.mode === "local" || match.setup.mode === "puzzle") return null;
  const finished = readPosition(match.moves, match.setup.initial, rule);
  if (finished?.winner !== attacker) return null;
  const last = match.moves.length - 1;
  const firstDefense = Math.max(match.lockedPly, last - 14);
  const deadline = performance.now() + 85;
  let lesson = null;
  for (let ply = firstDefense; ply < last; ply++) {
    if (performance.now() >= deadline) break;
    if (match.moves[ply].player !== defender) continue;
    const attack = readPosition(match.moves.slice(0, ply + 1), match.setup.initial, rule);
    if (!attack || attack.turn !== attacker) continue;
    const threat = proveFourAttack(attack.board, attacker, rule, 3, Math.min(10, deadline - performance.now()));
    if (typeof threat !== "number") continue;
    const original = match.moves[ply];
    attack.board[idx(original.r, original.c)] = 0;
    const alternatives = [];
    for (let square = 0; square < attack.board.length; square++) {
      if (attack.board[square] !== 0 || square === idx(original.r, original.c)) continue;
      const r = Math.floor(square / BOARD), c = square % BOARD;
      if (!forbiddenMove(attack.board, r, c, defender, rule)) alternatives.push(square);
    }
    alternatives.sort((a, b) => {
      const r = Math.floor(threat / BOARD), c = threat % BOARD;
      const distance = (n: number) => Math.abs(Math.floor(n / BOARD) - r) + Math.abs(n % BOARD - c);
      return distance(a) - distance(b);
    });
    for (const alternative of alternatives) {
      if (performance.now() >= deadline) break;
      attack.board[alternative] = defender;
      const win = checkWin(attack.board, Math.floor(alternative / BOARD), alternative % BOARD, defender).win;
      const result = win ? null : proveFourAttack(attack.board, attacker, rule, 3, Math.min(10, deadline - performance.now()));
      attack.board[alternative] = 0;
      if (result === null) {
        lesson = { defendPly: ply, attackPly: ply + 1, tactical: true };
        break;
      }
    }
    if (lesson) break;
  }
  if (lesson) return lesson;
  const defendPly = Math.max(match.lockedPly, last - 1);
  return { defendPly, attackPly: last, tactical: false };
}
