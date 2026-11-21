export const BOARD = 15;
export const idx = (r, c) => r * BOARD + c;
export const inBounds = (r, c) => r >= 0 && r < BOARD && c >= 0 && c < BOARD;
const directions = [[0, 1], [1, 0], [1, 1], [1, -1]];

function count(board, r, c, dr, dc, player) {
  let n = 0;
  for (r += dr, c += dc; inBounds(r, c) && board[idx(r, c)] === player; r += dr, c += dc) n++;
  return n;
}

export function winningLine(board, r, c, player) {
  for (const [dr, dc] of directions) {
    const ahead = count(board, r, c, dr, dc, player);
    const behind = count(board, r, c, -dr, -dc, player);
    if (ahead + behind + 1 < 5) continue;
    const line = [];
    for (let i = -behind; i <= ahead; i++) line.push([r + dr * i, c + dc * i]);
    return line;
  }
  return undefined;
}

// A three needs a legal extension to an open straight four containing the new stone.
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
      if (cell !== 0 || gap) { valid = false; break; }
      gap = [row, col];
    }
    if (valid && gap && !extensions.some(([row, col]) => row === gap[0] && col === gap[1])) {
      extensions.push(gap);
    }
  }
  return extensions;
}

export function isBlackDoubleThree(board, r, c) {
  const square = idx(r, c);
  if (!inBounds(r, c) || board[square] !== 0) return false;
  board[square] = 1;
  try {
    const directionsWithExtensions = [];
    for (const [dr, dc] of directions) {
      const extensions = extensionsInDirection(board, r, c, dr, dc);
      if (extensions.length) directionsWithExtensions.push(extensions);
    }
    // This variant allows a winning five or overline even if the move also creates two threes.
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

const offsets = [-4, -3, -2, -1, 1, 2, 3, 4];
const weights = offsets.map((_, bit) => 3 ** bit);
let patternTables;

function doubleThreeTables() {
  const extensions = new Uint8Array(3 ** offsets.length);
  const cell = (code, offset) => offset === 0 ? 1 : (Math.floor(code / weights[offsets.indexOf(offset)]) % 3);
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

/** Maintain four local pattern codes per square as search makes and unmakes moves. */
export function createDoubleThreeIndex(board) {
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
