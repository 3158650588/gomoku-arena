import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BOARD, idx, inBounds, winningLine } from "./board-rules.mjs";

export const ARENA_MAX_MS = 12000;
const modelFolder = fileURLToPath(new URL("../third-party/rapfi/native/", import.meta.url));
const variants = ["avx2", "sse"].map((arch) => join(modelFolder, `pbrain-rapfi-windows-${arch}.exe`));

export function readEnginePosition(input) {
  if (!input || !Array.isArray(input.history) || input.history.length >= BOARD * BOARD ||
      (input.player !== 1 && input.player !== 2) || input.player !== input.history.length % 2 + 1 ||
      !Number.isInteger(input.timeMs) || input.timeMs < 80 || input.timeMs > ARENA_MAX_MS) return null;
  const board = new Uint8Array(BOARD * BOARD);
  const history = [];
  for (const [i, move] of input.history.entries()) {
    if (!move || !Number.isInteger(move.r) || !Number.isInteger(move.c) || !inBounds(move.r, move.c) ||
        move.player !== i % 2 + 1 || board[idx(move.r, move.c)]) return null;
    if (winningLine(board, move.r, move.c, move.player)) return null;
    board[idx(move.r, move.c)] = move.player;
    history.push({ r: move.r, c: move.c, player: move.player });
  }
  return { history, board, player: input.player, timeMs: input.timeMs };
}

function run(binary, position, threads, signal) {
  const { history, player, timeMs, board } = position;
  const setup = [
    `START ${BOARD}`, "INFO RULE 0", `INFO THREAD_NUM ${threads}`, "INFO STRENGTH 100",
    "INFO HASH_SIZE 65536", "INFO TIMEOUT_MATCH 86400000", "INFO TIME_LEFT 2147483647",
    `INFO TIMEOUT_TURN ${timeMs}`,
  ];
  const moves = history.length ? [
    "BOARD", ...history.map(({ r, c, player: side }) => `${c},${r},${side === player ? 1 : 2}`), "DONE",
  ] : ["BEGIN"];
  return new Promise((resolve, reject) => {
    const process = spawn(binary, [], { cwd: modelFolder, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    let buffer = "", bytes = 0, done = false;
    const abort = () => finish(new Error("Rapfi search cancelled"));
    const timer = setTimeout(() => finish(new Error("Rapfi search timed out")), timeMs + 1300);
    function finish(error, move) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      process.kill();
      if (error) reject(error);
      else resolve(move);
    }
    process.on("error", finish);
    process.on("close", () => finish(new Error("Rapfi exited before returning a move")));
    process.stdin.on("error", finish);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) return abort();
    process.stdout.setEncoding("utf8");
    process.stdout.on("data", (chunk) => {
      if ((bytes += chunk.length) > 192000) return finish(new Error("Rapfi output exceeded its limit"));
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const raw of lines) {
        const line = raw.trim();
        if (line.startsWith("ERROR")) return finish(new Error(line));
        const match = line.match(/^(\d{1,2}),(\d{1,2})$/);
        if (!match) continue;
        const c = Number(match[1]), r = Number(match[2]);
        if (!inBounds(r, c) || board[idx(r, c)]) return finish(new Error("Rapfi returned an illegal move"));
        return finish(null, { r, c, player });
      }
    });
    process.stdin.write([...setup, ...moves, ""].join("\n"));
  });
}

export function createNativeEngine() {
  if (process.platform !== "win32" || process.arch !== "x64") return null;
  const binaries = variants.filter((file) => existsSync(file));
  if (!binaries.length || !existsSync(join(modelFolder, "mix9svqfreestyle_bsmix.bin.lz4"))) return null;
  const threads = Math.min(8, Math.max(1, availableParallelism() - 1));
  let selected, active = false;
  return {
    threads,
    async move(position, signal) {
      if (active) throw new Error("The local engine is busy");
      active = true;
      try {
        const started = performance.now();
        for (const binary of selected ? [selected, ...binaries.filter((path) => path !== selected)] : binaries) {
          const remaining = Math.floor(position.timeMs - (performance.now() - started));
          if (signal?.aborted || remaining < 60) break;
          try {
            const move = await run(binary, { ...position, timeMs: remaining }, threads, signal);
            selected = binary;
            return move;
          } catch (error) {
            if (signal?.aborted) throw error;
          }
        }
        throw new Error("The local Rapfi engine could not return a move");
      } finally {
        active = false;
      }
    },
  };
}
