/* Dedicated classic worker for the Rapfi Gomocup engine. */
/* global Rapfi */

const boardSize = 15;
let output = [];
const engine = initialize();

async function initialize() {
  try {
    importScripts("./rapfi-single-simd128.js");
    const response = await fetch(new URL("./rapfi-single-simd128.data", self.location.href));
    if (!response.ok) throw new Error(`Rapfi model download failed (HTTP ${response.status})`);
    const weights = await response.arrayBuffer();
    if (weights.byteLength !== 40382079) throw new Error("Rapfi model file is incomplete");
    const rapfi = await Rapfi({
      locateFile: (file) => new URL(file, self.location.href).href,
      getPreloadedPackage: () => weights,
      onReceiveStdout: (line) => output.push(line),
      onReceiveStderr: (line) => output.push(line),
    });
    rapfi.sendCommand(`START ${boardSize}`);
    rapfi.sendCommand("INFO RULE 0"); // Freestyle, including overlines.
    rapfi.sendCommand("INFO HASH_SIZE 32768");
    rapfi.sendCommand("INFO TIMEOUT_MATCH 86400000");
    if (!output.includes("OK") || output.some((line) => line.startsWith("ERROR"))) {
      throw new Error(output.join("\n") || "Rapfi did not acknowledge START");
    }
    output = [];
    self.postMessage({ type: "ready" });
    return rapfi;
  } catch (error) {
    self.postMessage({ type: "error", message: String(error) });
    return null;
  }
}

function readCandidates(lines) {
  const depths = new Map();
  let pv = null;
  for (const line of lines) {
    const match = line.match(/^INFO (PV|DEPTH|EVAL|BESTLINE) (.*)$/);
    if (!match) continue;
    const [, name, value] = match;
    if (name === "PV" && value !== "DONE") pv = {};
    else if (name === "PV") {
      if (pv?.point && Number.isInteger(pv.depth) && Number.isFinite(pv.value)) {
        const candidates = depths.get(pv.depth) ?? [];
        candidates.push(pv);
        depths.set(pv.depth, candidates);
      }
      pv = null;
    } else if (pv && name === "DEPTH") pv.depth = Number(value);
    else if (pv && name === "EVAL") pv.value = Number(value);
    else if (pv && name === "BESTLINE") {
      const point = value.match(/^(\d+),(\d+)/);
      if (point) pv.point = { r: Number(point[2]), c: Number(point[1]) };
    }
  }
  return depths;
}

function styledMove(candidates, move, preferences) {
  const same = ({ point }) => point.r === move.r && point.c === move.c;
  const reference = candidates.find(same);
  if (!reference || Math.abs(reference.value) >= 1000) return move;
  const styleScore = ({ point, value }) => value + (preferences[point.r * boardSize + point.c] ?? 0);
  return candidates.reduce((best, candidate) => Math.abs(candidate.value) < 1000 &&
    Math.abs(candidate.value - reference.value) <= 92 && styleScore(candidate) > styleScore(best)
    ? candidate : best, reference).point;
}

function shortlist(depths, move, history) {
  const occupied = new Set(history.map(({ r, c }) => r * boardSize + c));
  for (const depth of Array.from(depths.keys()).sort((a, b) => b - a)) {
    const candidates = depths.get(depth);
    const reference = candidates.find(({ point }) => point.r === move.r && point.c === move.c);
    if (!reference || candidates.length < 2) continue;
    if (Math.abs(reference.value) >= 1000) return [];
    return candidates.filter(({ point: { r, c }, value }) => r >= 0 && c >= 0 && r < boardSize && c < boardSize &&
      !occupied.has(r * boardSize + c) && Math.abs(value) < 1000 && Math.abs(value - reference.value) <= 125)
      .map(({ point }) => point).slice(0, 3);
  }
  return [];
}

self.onmessage = async ({ data: { token, history, player, timeMs, maxDepth = 99, strength = 100, preferences = null, multiple = false } }) => {
  const rapfi = await engine;
  if (!rapfi) return;
  try {
    output = [];
    rapfi.sendCommand(`INFO TIMEOUT_TURN ${timeMs}`);
    rapfi.sendCommand(`INFO MAX_DEPTH ${maxDepth}`);
    rapfi.sendCommand(`INFO STRENGTH ${strength}`);
    const detailed = preferences || multiple;
    rapfi.sendCommand(`INFO SHOW_DETAIL ${detailed ? 2 : 0}`);
    rapfi.sendCommand("INFO TIME_LEFT 2147483647");
    if (history.length) {
      // Order matters: send the full chronological history in one command.
      const stones = history.map(({ r, c, player: color }) =>
        `${c},${r},${color === player ? 1 : 2}`);
      rapfi.sendCommand([detailed ? "YXBOARD" : "BOARD", ...stones, "DONE"].join("\n"));
      if (detailed) rapfi.sendCommand("YXNBEST 3");
    } else {
      rapfi.sendCommand("RESTART");
      rapfi.sendCommand("BEGIN");
    }
    if (output.some((line) => line.startsWith("ERROR"))) {
      throw new Error(output.join("\n"));
    }
    const match = output.at(-1)?.trim().match(/^(\d+),(\d+)$/);
    let move = { r: match ? Number(match[2]) : -1, c: match ? Number(match[1]) : -1 };
    const depths = detailed ? readCandidates(output) : new Map();
    if (preferences && match) move = styledMove(depths.get(Math.max(...depths.keys())) ?? [], move, preferences);
    const { r, c } = move;
    if (r < 0 || c < 0 || r >= boardSize || c >= boardSize ||
        history.some((move) => move.r === r && move.c === c)) {
      throw new Error(`Rapfi returned an invalid move: ${output.at(-1)}`);
    }
    const alternatives = multiple ? shortlist(depths, move, history).map((point) => ({ ...point, player })) : [];
    self.postMessage({ type: "move", token, move: { r, c, player }, alternatives });
  } catch (error) {
    self.postMessage({ type: "error", token, message: String(error) });
  } finally {
    output = [];
  }
};
