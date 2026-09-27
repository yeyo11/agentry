/*
 * A QR code encoder (ISO/IEC 18004) for the one thing Agentry draws as a QR: a tunnel's address,
 * for a phone to scan off the screen. Byte mode, error correction level M, versions 1 to 10, which
 * holds 213 bytes; an `https://<id>.lhr.life` address is about 30. Written here rather than taken
 * from a package: this subset is small, and a dependency would ship every mode and version for it.
 */

/** The dark modules, row by row; `size` is 4 × version + 17, without the quiet zone. */
export interface QrMatrix {
  size: number;
  version: number;
  mask: number;
  modules: boolean[][];
}

const MAX_VERSION = 10;
// Level M, indexed by version − 1: EC codewords per block, and how many blocks
const ECC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
// Level M's two bits in the format information (L is 01, M 00, Q 11, H 10)
const FORMAT_M = 0;

/** Multiplies in GF(2⁸) modulo x⁸ + x⁴ + x³ + x² + 1, the field of QR's Reed-Solomon code. */
function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** The generator polynomial of `degree`, highest term dropped, coefficients from x^(degree−1) down. */
function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j] ?? 0, root);
      if (j + 1 < degree) result[j] = (result[j] ?? 0) ^ (result[j + 1] ?? 0);
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

/** The error correction codewords of `data`: the remainder of its division by the generator. */
export function reedSolomon(data: readonly number[], degree: number): number[] {
  const divisor = rsDivisor(degree);
  const result = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() ?? 0);
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] = (result[i] ?? 0) ^ gfMul(coef, factor);
    });
  }
  return result;
}

/** Modules left for data and error correction once every function pattern is placed. */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

const totalCodewords = (version: number) => Math.floor(rawDataModules(version) / 8);
const dataCodewords = (version: number) => totalCodewords(version) - (ECC_PER_BLOCK[version - 1] ?? 0) * (BLOCKS[version - 1] ?? 0);
// The character count is 8 bits wide in byte mode up to version 9, 16 from 10
const countBits = (version: number) => (version <= 9 ? 8 : 16);

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let pos = version * 4 + 17 - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
  return result;
}

/** 15 bits: the level and mask, BCH-protected and XOR-ed so they are never all light. */
export function formatBits(mask: number): number {
  const data = (FORMAT_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

const MASKS: ReadonlyArray<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** The data codewords: mode, count, the bytes, a terminator and the fixed padding. */
function encodeData(bytes: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, countBits(version));
  for (const byte of bytes) put(byte, 8);
  const capacity = dataCodewords(version) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) codewords.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  for (let pad = 0xec; codewords.length < dataCodewords(version); pad ^= 0xec ^ 0x11) codewords.push(pad);
  return codewords;
}

/** Splits the data into blocks, adds each one's error correction, and interleaves them. */
function interleave(data: readonly number[], version: number): number[] {
  const blocks = BLOCKS[version - 1] ?? 1;
  const ecc = ECC_PER_BLOCK[version - 1] ?? 0;
  const raw = totalCodewords(version);
  const shortBlocks = blocks - (raw % blocks);
  const shortData = Math.floor(raw / blocks) - ecc;
  const dataBlocks: number[][] = [];
  const eccBlocks: number[][] = [];
  for (let i = 0, at = 0; i < blocks; i++) {
    const length = shortData + (i < shortBlocks ? 0 : 1);
    const block = data.slice(at, at + length);
    at += length;
    dataBlocks.push(block);
    eccBlocks.push(reedSolomon(block, ecc));
  }
  const result: number[] = [];
  for (let i = 0; i <= shortData; i++) for (const block of dataBlocks) if (i < block.length) result.push(block[i] ?? 0);
  for (let i = 0; i < ecc; i++) for (const block of eccBlocks) result.push(block[i] ?? 0);
  return result;
}

class Grid {
  readonly modules: boolean[][];
  readonly fixed: boolean[][];

  constructor(readonly size: number) {
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }

  set(x: number, y: number, dark: boolean): void {
    const row = this.modules[y];
    const fixedRow = this.fixed[y];
    if (!row || !fixedRow || x < 0 || x >= this.size) return;
    row[x] = dark;
    fixedRow[x] = true;
  }
}

function drawFunctionPatterns(grid: Grid, version: number): void {
  const { size } = grid;
  for (let i = 0; i < size; i++) {
    grid.set(6, i, i % 2 === 0);
    grid.set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const) {
    // The finder with its light separator around it
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) grid.set(x, y, distance !== 2 && distance !== 4);
      }
    }
  }
  const align = alignmentPositions(version);
  const last = align.length - 1;
  align.forEach((cx, i) =>
    align.forEach((cy, j) => {
      // The three corners the finders already hold
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) grid.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }),
  );
  // Reserved now, written for real once the mask is chosen
  drawFormat(grid, 0);
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      grid.set(a, b, dark);
      grid.set(b, a, dark);
    }
  }
}

function drawFormat(grid: Grid, mask: number): void {
  const { size } = grid;
  const bits = formatBits(mask);
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) grid.set(8, i, bit(i));
  grid.set(8, 7, bit(6));
  grid.set(8, 8, bit(7));
  grid.set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) grid.set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) grid.set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) grid.set(8, size - 15 + i, bit(i));
  grid.set(8, size - 8, true);
}

/** Lays the codewords in the two-column zigzag from the bottom right, around the function patterns. */
function drawCodewords(grid: Grid, codewords: readonly number[]): void {
  const { size } = grid;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (grid.fixed[y]?.[x] || i >= codewords.length * 8) continue;
        const row = grid.modules[y];
        if (row) row[x] = (((codewords[i >>> 3] ?? 0) >>> (7 - (i & 7))) & 1) === 1;
        i++;
      }
    }
  }
}

function applyMask(grid: Grid, mask: number): void {
  const test = MASKS[mask];
  if (!test) return;
  for (let y = 0; y < grid.size; y++) {
    for (let x = 0; x < grid.size; x++) {
      const row = grid.modules[y];
      if (row && !grid.fixed[y]?.[x] && test(x, y)) row[x] = !row[x];
    }
  }
}

/** The standard's penalty (runs, 2 × 2 blocks, finder look-alikes, balance): lower scans better. */
function penalty(modules: readonly boolean[][]): number {
  const size = modules.length;
  const at = (x: number, y: number) => modules[y]?.[x] === true;
  let score = 0;
  const lines = (read: (i: number, j: number) => boolean) => {
    for (let i = 0; i < size; i++) {
      let run = 1;
      let pattern = '';
      for (let j = 0; j < size; j++) {
        const dark = read(i, j);
        pattern += dark ? '1' : '0';
        if (j > 0 && dark === read(i, j - 1)) run++;
        else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
      if (run >= 5) score += run - 2;
      // A light quiet zone lies beyond both ends of the line
      const padded = `0000${pattern}0000`;
      for (let k = padded.indexOf('1011101'); k !== -1; k = padded.indexOf('1011101', k + 1)) {
        if (padded.slice(k - 4, k) === '0000' || padded.slice(k + 7, k + 11) === '0000') score += 40;
      }
    }
  };
  lines((i, j) => at(j, i));
  lines((i, j) => at(i, j));
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (at(x, y)) dark++;
      if (x + 1 < size && y + 1 < size && at(x, y) === at(x + 1, y) && at(x, y) === at(x, y + 1) && at(x, y) === at(x + 1, y + 1)) score += 3;
    }
  }
  score += Math.floor(Math.abs((dark * 20) / (size * size) - 10)) * 10;
  return score;
}

/** The QR code of `text`, or null when it is too long for version 10 at level M. */
export function encodeQr(text: string): QrMatrix | null {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  while (version <= MAX_VERSION && 4 + countBits(version) + bytes.length * 8 > dataCodewords(version) * 8) version++;
  if (version > MAX_VERSION) return null;
  const codewords = interleave(encodeData(bytes, version), version);
  const size = version * 4 + 17;

  let best: QrMatrix | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < MASKS.length; mask++) {
    const grid = new Grid(size);
    drawFunctionPatterns(grid, version);
    drawCodewords(grid, codewords);
    applyMask(grid, mask);
    drawFormat(grid, mask);
    const score = penalty(grid.modules);
    if (score < bestScore) {
      bestScore = score;
      best = { size, version, mask, modules: grid.modules };
    }
  }
  return best;
}
