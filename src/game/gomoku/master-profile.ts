import { type Board, type Stone } from "./logic";
import { searchTime } from "./tactics";

export const MASTER_MODES = ["standard", "deep", "arena"] as const;
export type MasterMode = typeof MASTER_MODES[number];
export const MASTER_PROFILES = {
  standard: { freestyle: 3500, local: 2200, opening: 0, review: 240, depth: 12 },
  deep: { freestyle: 6000, local: 4200, opening: 1800, review: 520, depth: 16 },
  arena: { freestyle: 12000, local: 9000, opening: 2800, review: 1250, depth: 20 },
} as const;

export function masterBudget(board: Board, player: Stone, kind: "freestyle" | "local",
  mode: MasterMode, clockMs: number, bookPosition: boolean) {
  const profile = MASTER_PROFILES[mode];
  const time = searchTime(board, player, MASTER_PROFILES.standard[kind], clockMs, profile[kind]);
  if (!bookPosition || mode === "standard") return time;
  return Math.max(time, Math.min(profile.opening, Math.max(1, Math.floor(clockMs - 150))));
}
