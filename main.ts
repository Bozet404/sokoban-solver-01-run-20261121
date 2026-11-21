// A push-optimal Sokoban solver for make.fun's sokoban-solver-01-run-20261121.
//
// Idea: every generated level is a one-square hallway with one to four rooms
// off it, each room holding 3 or 4 boxes and as many goals, and a box that
// leaves its room through the door can never come back. So a level's
// push-optimal count is the sum of its rooms' optima, and each room can be
// solved on its own: the player walks in through the door, pushes every box
// of the room onto a goal, walks back out, and moves on to the next room.
// Inside a room the search is A* over pushes (not steps): a state is the
// player's square plus the boxes', each action is one push, and the estimate
// is the cheapest assignment of boxes to goals under push-distances that
// ignore other boxes. Boxes standing on a square from which no goal can be
// reached are cut off before the search wastes time on them. The search
// budget is counted in expanded states, never in wall-clock time, so two
// runs always write the same bytes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The four steps, in a fixed order so every search is deterministic.
const STEPS = [
  { dx: 0, dy: -1, ch: 'u' },
  { dx: 0, dy: 1, ch: 'd' },
  { dx: -1, dy: 0, ch: 'l' },
  { dx: 1, dy: 0, ch: 'r' },
] as const;

// Work budgets, counted in expanded states. A room that needs more than its
// budget gives up instead of running past the set's wall budget.
const ROOM_BUDGET = 1_000_000;
const WHOLE_BUDGET = 400_000;
const GLOBAL_BUDGET = 3_000_000;
let spent = 0;

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

// The cell one step from `cell` in direction `d`, or -1 past the board edge.
function stepCell(level: Level, cell: number, d: { dx: number; dy: number }): number {
  const x = cell % level.w;
  const y = Math.floor(cell / level.w);
  const nx = x + d.dx;
  const ny = y + d.dy;
  if (nx < 0 || nx >= level.w || ny < 0 || ny >= level.h) return -1;
  return ny * level.w + nx;
}

// Breadth-first walk from `start` over cells where `standable` is set and
// no box stands. Returns the parent of every reached cell (parent[start] is
// start itself, -1 where unreached).
function walkParents(
  level: Level,
  blocked: ReadonlySet<number>,
  start: number,
  standable: (cell: number) => boolean,
): Int32Array {
  const parent = new Int32Array(level.w * level.h).fill(-1);
  parent[start] = start;
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head]!;
    for (const d of STEPS) {
      const nxt = stepCell(level, cur, d);
      if (nxt < 0 || parent[nxt] !== -1) continue;
      if (level.wall[nxt] || blocked.has(nxt) || !standable(nxt)) continue;
      parent[nxt] = cur;
      queue.push(nxt);
    }
  }
  return parent;
}

// The walk from `from` to `to` as a move string, or null when unreachable.
// `parent` comes from walkParents started at `from`.
function pathString(level: Level, parent: Int32Array, from: number, to: number): string | null {
  if (parent[to] === -1) return null;
  const cells: number[] = [];
  for (let c = to; c !== from; c = parent[c]!) cells.push(c);
  cells.push(from);
  cells.reverse();
  let out = '';
  for (let k = 1; k < cells.length; k++) {
    const a = cells[k - 1]!;
    const b = cells[k]!;
    const dx = (b % level.w) - (a % level.w);
    const dy = Math.floor(b / level.w) - Math.floor(a / level.w);
    for (const d of STEPS) {
      if (d.dx === dx && d.dy === dy) {
        out += d.ch;
        break;
      }
    }
  }
  return out;
}

// A walk on the whole board (any floor cell), boxes as obstacles.
function walkWhole(level: Level, boxes: number[], from: number, to: number): string | null {
  const blocked = new Set(boxes);
  const parent = walkParents(level, blocked, from, () => true);
  return pathString(level, parent, from, to);
}

interface Room {
  cells: number[]; // floor cells of the room (the door cell included)
  door: number; // the room cell opening onto the hallway
  hall: number; // the hallway cell outside the door
  boxes: number[];
  goals: number[];
}

// Split a level into its hallway row and the rooms off it. Returns null when
// the level does not look like the generator's shape at all.
function decompose(level: Level): Room[] | null {
  const hallRow = Math.floor(level.player / level.w);
  const seen = new Uint8Array(level.w * level.h);
  const parts: number[][] = [];
  for (let i = 0; i < level.w * level.h; i++) {
    if (level.wall[i] || Math.floor(i / level.w) === hallRow || seen[i]) continue;
    const cells: number[] = [];
    const stack = [i];
    seen[i] = 1;
    while (stack.length > 0) {
      const cur = stack.pop()!;
      cells.push(cur);
      for (const d of STEPS) {
        const nxt = stepCell(level, cur, d);
        if (nxt < 0 || level.wall[nxt] || Math.floor(nxt / level.w) === hallRow || seen[nxt]) continue;
        seen[nxt] = 1;
        stack.push(nxt);
      }
    }
    parts.push(cells);
  }
  const rooms: Room[] = [];
  for (const cells of parts) {
    const cellSet = new Set(cells);
    const boxes = level.boxes.filter((b) => cellSet.has(b));
    const goals = level.goals.filter((g) => cellSet.has(g));
    if (boxes.length === 0 && goals.length === 0) continue;
    if (boxes.length !== goals.length) return null;
    // The door is the one room cell touching the hallway row.
    const doors = cells.filter((c) => {
      const up = c - level.w;
      const down = c + level.w;
      return (
        (up >= 0 && Math.floor(up / level.w) === hallRow && !level.wall[up]) ||
        (down < level.w * level.h && Math.floor(down / level.w) === hallRow && !level.wall[down])
      );
    });
    if (doors.length !== 1) return null;
    const door = doors[0]!;
    const hall = door - level.w >= 0 && Math.floor((door - level.w) / level.w) === hallRow
      ? door - level.w
      : door + level.w;
    rooms.push({ cells, door, hall, boxes, goals });
  }
  // Every box and goal must belong to exactly one room.
  const placed = rooms.reduce((a, r) => a + r.boxes.length, 0);
  if (placed !== level.boxes.length) return null;
  const placedGoals = rooms.reduce((a, r) => a + r.goals.length, 0);
  if (placedGoals !== level.goals.length) return null;
  return rooms;
}

// A small binary heap ordered by (f, -g, insertion order). Entries are
// [f, g, stateIndex, order].
class Heap {
  private items: [number, number, number, number][] = [];

  get size(): number {
    return this.items.length;
  }

  private static before(a: [number, number, number, number], b: [number, number, number, number]): boolean {
    if (a[0] !== b[0]) return a[0] < b[0];
    if (a[1] !== b[1]) return a[1] > b[1];
    return a[3] < b[3];
  }

  push(e: [number, number, number, number]): void {
    const items = this.items;
    items.push(e);
    let i = items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!Heap.before(items[i]!, items[p]!)) break;
      [items[i], items[p]] = [items[p]!, items[i]!];
      i = p;
    }
  }

  pop(): [number, number, number, number] {
    const items = this.items;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= items.length) break;
        if (c + 1 < items.length && Heap.before(items[c + 1]!, items[c]!)) c++;
        if (!Heap.before(items[c]!, items[i]!)) break;
        [items[i], items[c]] = [items[c]!, items[i]!];
        i = c;
      }
    }
    return top;
  }
}

interface Region {
  cells: number[]; // cells a box may stand on
  stand: (cell: number) => boolean; // cells the player may stand on
  boxes: number[];
  goals: number[];
  startPlayer: number;
  exit: number; // -1: no need to leave; else the cell the player must reach at the end
}

interface Solved {
  moves: string;
  pushes: number;
  endPlayer: number;
  endBoxes: number[];
  expansions: number;
}

// Push-optimal A* over one region. `budget` is the expansion budget for
// this call. Returns null when the budget runs out or no solution exists.
function solveRegion(level: Level, region: Region, budget: number): Solved | null {
  const { w } = level;
  const nBox = region.cells.length;
  // Local numbering: room cells 0..nBox-1, then the start square when it is
  // outside the cells (the hallway square outside a door).
  const localOf = new Int32Array(w * level.h).fill(-1);
  const cellOf: number[] = [];
  region.cells.forEach((c, k) => {
    localOf[c] = k;
    cellOf.push(c);
  });
  const outside = region.startPlayer;
  let hallLocal = -1;
  if (localOf[outside] < 0) {
    hallLocal = cellOf.length;
    localOf[outside] = hallLocal;
    cellOf.push(outside);
  }
  const base = cellOf.length + 1;
  const startLocal = localOf[region.startPlayer]!;
  const exitLocal = region.exit >= 0 ? localOf[region.exit]! : -1;
  const goalSet = new Set(region.goals.map((g) => localOf[g]!));
  const boxesLocal = region.boxes.map((b) => localOf[b]!).sort((a, b) => a - b);
  const m = boxesLocal.length;
  if (m === 0) {
    return { moves: '', pushes: 0, endPlayer: region.startPlayer, endBoxes: [], expansions: 0 };
  }

  // Push-distances from each goal, by reverse play: a box on cell x can be
  // pushed to a cell y already known to reach the goal when the square on
  // the far side of x (where the player must stand) is open floor. A
  // square no goal reaches this way is dead: a box on it can never be saved.
  const dist: Int32Array[] = [];
  for (const g of region.goals) {
    const d = new Int32Array(nBox).fill(-1);
    const gLocal = localOf[g]!;
    d[gLocal] = 0;
    const queue = [gLocal];
    for (let head = 0; head < queue.length; head++) {
      const y = queue[head]!;
      const yCell = cellOf[y]!;
      for (const dir of STEPS) {
        const aCell = stepCell(level, yCell, { dx: -dir.dx, dy: -dir.dy });
        if (aCell < 0) continue;
        const aLocal = localOf[aCell]!;
        if (aLocal < 0 || aLocal >= nBox || d[aLocal] !== -1) continue;
        const zCell = stepCell(level, aCell, { dx: -dir.dx, dy: -dir.dy });
        if (zCell < 0 || level.wall[zCell] || !region.stand(zCell)) continue;
        d[aLocal] = d[y]! + 1;
        queue.push(aLocal);
      }
    }
    dist.push(d);
  }
  const dead = new Uint8Array(nBox);
  for (let c = 0; c < nBox; c++) {
    if (goalSet.has(c)) continue;
    let live = false;
    for (let g = 0; g < m; g++) {
      if (dist[g]![c]! >= 0) {
        live = true;
        break;
      }
    }
    dead[c] = live ? 0 : 1;
  }

  // Cheapest assignment of boxes to goals under the push-distances, by
  // dynamic programming over subsets of goals. Infinity when no box can
  // reach its goal, or two boxes need the same one.
  const popcount = (x: number): number => {
    let n = 0;
    while (x > 0) {
      n += x & 1;
      x >>= 1;
    }
    return n;
  };
  const estimate = (boxes: number[]): number => {
    const dp = new Float64Array(1 << m).fill(Infinity);
    dp[0] = 0;
    for (let mask = 0; mask < (1 << m); mask++) {
      const k = popcount(mask);
      if (k >= m || dp[mask] === Infinity) continue;
      const b = boxes[k]!;
      for (let j = 0; j < m; j++) {
        if (mask & (1 << j)) continue;
        const d = dist[j]![b]!;
        if (d < 0) continue;
        const nm = mask | (1 << j);
        const v = dp[mask]! + d;
        if (v < dp[nm]!) dp[nm] = v;
      }
    }
    return dp[(1 << m) - 1]!;
  };

  const pack = (player: number, boxes: number[]): number => {
    let k = player;
    for (let i = m - 1; i >= 0; i--) k = k * base + boxes[i]!;
    for (let i = m; i < 4; i++) k = k * base + (base - 1);
    return k;
  };
  const solved = (boxes: number[]): boolean => boxes.every((b) => goalSet.has(b));

  const pLoc: number[] = [startLocal];
  const bLoc: number[][] = [boxesLocal];
  const gVal: number[] = [0];
  const parent: number[] = [-1];
  const seg: string[] = [''];
  const best = new Map<number, number>();
  best.set(pack(startLocal, boxesLocal), 0);
  const heap = new Heap();
  let order = 0;
  const h0 = estimate(boxesLocal);
  if (!Number.isFinite(h0)) return null;
  heap.push([h0, 0, 0, order++]);
  let expansions = 0;

  while (heap.size > 0) {
    const [, g, s] = heap.pop();
    if (best.get(pack(pLoc[s]!, bLoc[s]!)) !== s) continue;
    const boxes = bLoc[s]!;
    if (solved(boxes)) {
      // The player must be able to walk out through the door (rooms) or
      // anywhere at all (whole level, exit -1).
      if (exitLocal >= 0) {
        const blocked = new Set(boxes.map((b) => cellOf[b]!));
        const par = walkParents(level, blocked, cellOf[pLoc[s]!]!, (c) => region.stand(c));
        if (par[cellOf[exitLocal]!] === -1) {
          // Solved but shut in: keep searching for a way out.
          expansions++;
          if (expansions >= budget) return null;
          continue;
        }
      }
      let moves = '';
      for (let t = s; t > 0; t = parent[t]!) moves = seg[t]! + moves;
      return {
        moves,
        pushes: g,
        endPlayer: cellOf[pLoc[s]!]!,
        endBoxes: boxes.map((b) => cellOf[b]!),
        expansions,
      };
    }
    if (expansions >= budget || spent >= GLOBAL_BUDGET) return null;
    expansions++;
    spent++;
    const playerCell = cellOf[pLoc[s]!]!;
    const blocked = new Set(boxes.map((b) => cellOf[b]!));
    const par = walkParents(level, blocked, playerCell, (c) => region.stand(c));
    for (let bi = 0; bi < m; bi++) {
      const bCell = cellOf[boxes[bi]!]!;
      for (const dir of STEPS) {
        const tCell = stepCell(level, bCell, dir);
        if (tCell < 0 || level.wall[tCell]) continue;
        const tLocal = localOf[tCell]!;
        if (tLocal < 0 || tLocal >= nBox || blocked.has(tCell)) continue;
        const sCell = stepCell(level, bCell, { dx: -dir.dx, dy: -dir.dy });
        if (sCell < 0 || par[sCell] === -1) continue;
        const walk = pathString(level, par, playerCell, sCell);
        if (walk === null) continue;
        const nb = boxes.slice();
        nb[bi] = tLocal;
        nb.sort((a, b) => a - b);
        if (nb.some((b) => dead[b]!)) continue;
        const h = estimate(nb);
        if (!Number.isFinite(h)) continue;
        const ng = g + 1;
        const key = pack(localOf[bCell]!, nb);
        const seen = best.get(key);
        if (seen !== undefined && gVal[seen]! <= ng) continue;
        const t = pLoc.length;
        pLoc.push(localOf[bCell]!);
        bLoc.push(nb);
        gVal.push(ng);
        parent.push(s);
        seg.push(walk + dir.ch);
        best.set(key, t);
        heap.push([ng + h, ng, t, order++]);
      }
    }
  }
  return null;
}

// Solve one level: room by room when it has the generator's shape, else
// one search over the whole board.
function solveLevel(text: string): string {
  const level = parseLevel(text);
  const rooms = decompose(level);
  if (rooms !== null && rooms.length > 0) {
    const px = level.player % level.w;
    rooms.sort((a, b) => Math.abs(a.door % level.w - px) - Math.abs(b.door % level.w - px));
    let moves = '';
    let curPlayer = level.player;
    let curBoxes = [...level.boxes];
    for (const room of rooms) {
      const walkIn = walkWhole(level, curBoxes, curPlayer, room.hall);
      if (walkIn === null) return '';
      moves += walkIn;
      const roomBoxes = room.boxes.filter((b) => curBoxes.includes(b));
      const solved = solveRegion(
        level,
        {
          cells: room.cells,
          stand: (c) => c === room.hall || room.cells.includes(c),
          boxes: roomBoxes,
          goals: room.goals,
          startPlayer: room.hall,
          exit: room.door,
        },
        ROOM_BUDGET,
      );
      if (solved === null) return '';
      moves += solved.moves;
      curPlayer = solved.endPlayer;
      curBoxes = curBoxes.filter((b) => !room.boxes.includes(b)).concat(solved.endBoxes);
    }
    return moves;
  }
  const all = solveRegion(
    level,
    {
      cells: level.goals.length > 0 ? allFloor(level) : [],
      stand: () => true,
      boxes: level.boxes,
      goals: level.goals,
      startPlayer: level.player,
      exit: -1,
    },
    WHOLE_BUDGET,
  );
  return all === null ? '' : all.moves;
}

function allFloor(level: Level): number[] {
  const out: number[] = [];
  for (let i = 0; i < level.w * level.h; i++) {
    if (!level.wall[i]) out.push(i);
  }
  return out;
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  let moves = '';
  try {
    moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
