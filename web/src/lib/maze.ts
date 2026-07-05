// Maze generation using recursive backtracker
// Returns a 2D grid: 0 = open, 1 = wall

export const TILE = 40; // px per tile

export function generateMaze(cols: number, rows: number): number[][] {
  // Must be odd dimensions for proper maze generation
  const w = cols % 2 === 0 ? cols - 1 : cols;
  const h = rows % 2 === 0 ? rows - 1 : rows;

  // Start all walls
  const grid: number[][] = Array.from({ length: h }, () => Array(w).fill(1));

  const visited = Array.from({ length: h }, () => Array(w).fill(false));

  function carve(cx: number, cy: number) {
    visited[cy]![cx] = true;
    const dirs = shuffle([
      [0, -2],
      [0, 2],
      [-2, 0],
      [2, 0],
    ]);
    for (const [dx, dy] of dirs) {
      const nx = cx + dx!;
      const ny = cy + dy!;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && !visited[ny]![nx]) {
        // Carve passage
        grid[cy + dy! / 2]![cx + dx! / 2] = 0;
        grid[ny]![nx] = 0;
        carve(nx, ny);
      }
    }
  }

  // Start from (1,1)
  grid[1]![1] = 0;
  carve(1, 1);

  // Open entry and exit
  grid[1]![0] = 0; // left entry
  grid[h - 2]![w - 1] = 0; // right exit

  return grid;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

export function isWall(grid: number[][], tx: number, ty: number): boolean {
  if (ty < 0 || ty >= grid.length) return true;
  const row = grid[ty];
  if (!row) return true;
  if (tx < 0 || tx >= row.length) return true;
  return row[tx] === 1;
}

/** Axis-aligned rectangle vs tile collision — returns overlap vector or null */
export function resolveAABBvsTiles(
  grid: number[][],
  x: number,
  y: number,
  radius: number
): { dx: number; dy: number } | null {
  const left = x - radius;
  const right = x + radius;
  const top = y - radius;
  const bottom = y + radius;

  const tileLeft = Math.floor(left / TILE);
  const tileRight = Math.floor(right / TILE);
  const tileTop = Math.floor(top / TILE);
  const tileBottom = Math.floor(bottom / TILE);

  let pushX = 0;
  let pushY = 0;

  for (let ty = tileTop; ty <= tileBottom; ty++) {
    for (let tx = tileLeft; tx <= tileRight; tx++) {
      if (!isWall(grid, tx, ty)) continue;
      const tileX = tx * TILE;
      const tileY = ty * TILE;
      // Find overlap
      const overlapLeft = right - tileX;
      const overlapRight = tileX + TILE - left;
      const overlapTop = bottom - tileY;
      const overlapBottom = tileY + TILE - top;

      const minX = Math.min(overlapLeft, overlapRight);
      const minY = Math.min(overlapTop, overlapBottom);

      if (minX < minY) {
        if (overlapLeft < overlapRight) pushX -= overlapLeft;
        else pushX += overlapRight;
      } else {
        if (overlapTop < overlapBottom) pushY -= overlapTop;
        else pushY += overlapBottom;
      }
    }
  }

  if (pushX !== 0 || pushY !== 0) return { dx: pushX, dy: pushY };
  return null;
}

/** Get open cell positions (center of tiles) excluding border */
export function getOpenCells(grid: number[][]): { x: number; y: number }[] {
  const cells: { x: number; y: number }[] = [];
  for (let ty = 0; ty < grid.length; ty++) {
    const row = grid[ty]!;
    for (let tx = 0; tx < row.length; tx++) {
      if (row[tx] === 0) {
        cells.push({ x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 });
      }
    }
  }
  return cells;
}
