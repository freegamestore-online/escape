import { GameShell, GameTopbar } from "@freegamestore/games";
import { useRef, useEffect, useCallback, useState } from "react";
import { useGameLoop } from "./hooks/useGameLoop";
import { useHighScore } from "./hooks/useHighScore";
import { generateMaze, isWall, resolveAABBvsTiles, getOpenCells, TILE } from "./lib/maze";
import { drawGlow, drawText, lerp, clamp, dist, randomInRange } from "./lib/canvas";
import type { Player, Zombie, Bullet, Particle, GamePhase } from "./types";

// ── Constants ──────────────────────────────────────────────────────────────
const MAZE_COLS = 21;
const MAZE_ROWS = 17;
const PLAYER_RADIUS = 10;
const ZOMBIE_RADIUS = 11;
const BULLET_RADIUS = 5;
const PLAYER_SPEED = 140;
const ZOMBIE_SPEED_WALKER = 52;
const ZOMBIE_SPEED_RUNNER = 90;
const BULLET_SPEED = 340;
const BULLET_LIFE = 1.4;
const SHOOT_COOLDOWN = 0.28;
const ZOMBIE_ATTACK_RANGE = PLAYER_RADIUS + ZOMBIE_RADIUS + 2;
const ZOMBIE_ATTACK_COOLDOWN = 1.0;
const ZOMBIE_DAMAGE = 1;
const PLAYER_MAX_HP = 5;
const ZOMBIE_COUNT = 8;
const INVINCIBLE_TIME = 0.8;

let nextId = 1;
function uid() { return nextId++; }

// ── Maze setup ─────────────────────────────────────────────────────────────
function buildLevel() {
  const grid = generateMaze(MAZE_COLS, MAZE_ROWS);
  const open = getOpenCells(grid);
  // Player starts top-left open cell
  const playerStart = open.find(c => c.x < TILE * 3 && c.y < TILE * 3) ?? open[0] ?? { x: TILE * 1.5, y: TILE * 1.5 };

  // Zombies placed far from player
  const farCells = open
    .filter(c => dist(c.x, c.y, playerStart.x, playerStart.y) > TILE * 6)
    .sort(() => Math.random() - 0.5)
    .slice(0, ZOMBIE_COUNT);

  const zombies: Zombie[] = farCells.map((c, i) => ({
    id: uid(),
    x: c.x,
    y: c.y,
    vx: 0,
    vy: 0,
    hp: 2,
    maxHp: 2,
    angle: 0,
    attackCooldown: 0,
    type: i < 2 ? "runner" : "walker",
  }));

  const player: Player = {
    x: playerStart.x,
    y: playerStart.y,
    vx: 0,
    vy: 0,
    hp: PLAYER_MAX_HP,
    maxHp: PLAYER_MAX_HP,
    angle: 0,
    shootCooldown: 0,
    invincible: 0,
  };

  return { grid, player, zombies };
}

// ── Main Component ─────────────────────────────────────────────────────────
export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [score, setScore] = useState(0);
  const [_highScore, updateHighScore] = useHighScore("zombie-maze-hs");
  const [phase, setPhase] = useState<GamePhase>("playing");
  const [killCount, setKillCount] = useState(0);

  // Game state in refs (no re-render on every frame)
  const gridRef = useRef<number[][]>([]);
  const playerRef = useRef<Player | null>(null);
  const zombiesRef = useRef<Zombie[]>([]);
  const bulletsRef = useRef<Bullet[]>([]);
  const particlesRef = useRef<Particle[]>([]);
  const phaseRef = useRef<GamePhase>("playing");
  const scoreRef = useRef(0);
  const killCountRef = useRef(0);
  const cameraRef = useRef({ x: 0, y: 0 });
  const canvasSizeRef = useRef({ w: 600, h: 400 });

  // Input state
  const keysRef = useRef<Set<string>>(new Set());
  const mouseRef = useRef({ x: 0, y: 0, down: false });
  const touchRef = useRef({ x: 0, y: 0, active: false, fired: false });
  const joystickRef = useRef({ active: false, startX: 0, startY: 0, dx: 0, dy: 0 });

  // Confetti for win screen
  const confettiRef = useRef<Particle[]>([]);

  const initGame = useCallback(() => {
    nextId = 1;
    const { grid, player, zombies } = buildLevel();
    gridRef.current = grid;
    playerRef.current = player;
    zombiesRef.current = zombies;
    bulletsRef.current = [];
    particlesRef.current = [];
    confettiRef.current = [];
    phaseRef.current = "playing";
    scoreRef.current = 0;
    killCountRef.current = 0;
    setScore(0);
    setKillCount(0);
    setPhase("playing");
  }, []);

  useEffect(() => {
    initGame();
  }, [initGame]);

  // Resize canvas
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const obs = new ResizeObserver(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      canvas.width = w;
      canvas.height = h;
      canvasSizeRef.current = { w, h };
    });
    obs.observe(container);
    return () => obs.disconnect();
  }, []);

  // Input listeners
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      keysRef.current.add(e.key);
      if (["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"," "].includes(e.key)) e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => keysRef.current.delete(e.key);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => { window.removeEventListener("keydown", onKeyDown); window.removeEventListener("keyup", onKeyUp); };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onMouseMove = (e: MouseEvent) => { mouseRef.current.x = e.clientX; mouseRef.current.y = e.clientY; };
    const onMouseDown = () => { mouseRef.current.down = true; };
    const onMouseUp = () => { mouseRef.current.down = false; };

    const onTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      const t = e.touches[0];
      if (!t) return;
      touchRef.current = { x: t.clientX, y: t.clientY, active: true, fired: false };
      joystickRef.current = { active: true, startX: t.clientX, startY: t.clientY, dx: 0, dy: 0 };
    };
    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      const t = e.touches[0];
      if (!t) return;
      touchRef.current.x = t.clientX;
      touchRef.current.y = t.clientY;
      const jx = t.clientX - joystickRef.current.startX;
      const jy = t.clientY - joystickRef.current.startY;
      const jlen = Math.sqrt(jx*jx + jy*jy);
      const maxJ = 50;
      joystickRef.current.dx = jlen > 0 ? (jx / jlen) * Math.min(jlen, maxJ) / maxJ : 0;
      joystickRef.current.dy = jlen > 0 ? (jy / jlen) * Math.min(jlen, maxJ) / maxJ : 0;
    };
    const onTouchEnd = (e: TouchEvent) => {
      e.preventDefault();
      if (e.touches.length === 0) {
        touchRef.current.active = false;
        joystickRef.current.active = false;
        joystickRef.current.dx = 0;
        joystickRef.current.dy = 0;
      }
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);
    canvas.addEventListener("touchstart", onTouchStart, { passive: false });
    canvas.addEventListener("touchmove", onTouchMove, { passive: false });
    canvas.addEventListener("touchend", onTouchEnd, { passive: false });

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("touchmove", onTouchMove);
      canvas.removeEventListener("touchend", onTouchEnd);
    };
  }, []);

  // ── Spawn blood particles ──────────────────────────────────────────────
  function spawnBlood(x: number, y: number, count: number) {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = randomInRange(30, 120);
      particlesRef.current.push({
        id: uid(), x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: randomInRange(0.3, 0.7),
        maxLife: 0.6,
        color: "#cc2222",
        size: randomInRange(2, 5),
      });
    }
  }

  function spawnConfetti() {
    const colors = ["#ff4444","#44ff44","#4444ff","#ffff44","#ff44ff","#44ffff","#ff8844"];
    const { w, h } = canvasSizeRef.current;
    for (let i = 0; i < 120; i++) {
      const angle = -Math.PI / 2 + randomInRange(-0.8, 0.8);
      const speed = randomInRange(200, 500);
      confettiRef.current.push({
        id: uid(),
        x: randomInRange(0, w),
        y: randomInRange(-20, h * 0.3),
        vx: Math.cos(angle) * speed * 0.4,
        vy: Math.sin(angle) * speed,
        life: randomInRange(1.5, 3.0),
        maxLife: 3.0,
        color: colors[Math.floor(Math.random() * colors.length)] ?? "#ff4444",
        size: randomInRange(4, 10),
      });
    }
  }

  // ── Game loop ──────────────────────────────────────────────────────────
  const paused = phase !== "playing";

  useGameLoop((dt: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { w, h } = canvasSizeRef.current;
    const player = playerRef.current;
    const grid = gridRef.current;

    // ── Update confetti on win/dead screens ─────────────────────────────
    if (phaseRef.current !== "playing") {
      confettiRef.current.forEach(p => {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += 200 * dt;
        p.life -= dt;
      });
      confettiRef.current = confettiRef.current.filter(p => p.life > 0);
      renderWinOrDead(ctx, w, h);
      return;
    }

    if (!player) return;

    // ── Player movement ─────────────────────────────────────────────────
    let mx = 0, my = 0;
    const keys = keysRef.current;
    if (keys.has("ArrowLeft") || keys.has("a") || keys.has("A")) mx -= 1;
    if (keys.has("ArrowRight") || keys.has("d") || keys.has("D")) mx += 1;
    if (keys.has("ArrowUp") || keys.has("w") || keys.has("W")) my -= 1;
    if (keys.has("ArrowDown") || keys.has("s") || keys.has("S")) my += 1;

    // Touch joystick
    if (joystickRef.current.active) {
      mx += joystickRef.current.dx;
      my += joystickRef.current.dy;
    }

    const mlen = Math.sqrt(mx * mx + my * my);
    if (mlen > 0) { mx /= mlen; my /= mlen; }

    player.vx = lerp(player.vx, mx * PLAYER_SPEED, Math.min(1, dt * 12));
    player.vy = lerp(player.vy, my * PLAYER_SPEED, Math.min(1, dt * 12));

    player.x += player.vx * dt;
    const pushX = resolveAABBvsTiles(grid, player.x, player.y, PLAYER_RADIUS);
    if (pushX) { player.x += pushX.dx; player.vx = 0; }

    player.y += player.vy * dt;
    const pushY = resolveAABBvsTiles(grid, player.x, player.y, PLAYER_RADIUS);
    if (pushY) { player.y += pushY.dy; player.vy = 0; }

    // Player angle (toward mouse)
    const cam = cameraRef.current;
    const screenPX = player.x - cam.x;
    const screenPY = player.y - cam.y;
    player.angle = Math.atan2(mouseRef.current.y - screenPY, mouseRef.current.x - screenPX);

    // Shoot cooldown
    player.shootCooldown = Math.max(0, player.shootCooldown - dt);
    player.invincible = Math.max(0, player.invincible - dt);

    // Shooting (mouse click or space)
    const wantShoot = mouseRef.current.down || keys.has(" ");
    if (wantShoot && player.shootCooldown <= 0) {
      player.shootCooldown = SHOOT_COOLDOWN;
      bulletsRef.current.push({
        id: uid(),
        x: player.x + Math.cos(player.angle) * (PLAYER_RADIUS + 6),
        y: player.y + Math.sin(player.angle) * (PLAYER_RADIUS + 6),
        vx: Math.cos(player.angle) * BULLET_SPEED,
        vy: Math.sin(player.angle) * BULLET_SPEED,
        life: BULLET_LIFE,
      });
    }

    // ── Bullets ─────────────────────────────────────────────────────────
    for (const b of bulletsRef.current) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.life -= dt;

      // Hit wall
      const tx = Math.floor(b.x / TILE);
      const ty = Math.floor(b.y / TILE);
      if (isWall(grid, tx, ty)) {
        b.life = 0;
        for (let i = 0; i < 4; i++) {
          const a = Math.random() * Math.PI * 2;
          particlesRef.current.push({ id: uid(), x: b.x, y: b.y, vx: Math.cos(a)*60, vy: Math.sin(a)*60, life: 0.3, maxLife: 0.3, color: "#ffcc44", size: 3 });
        }
      }

      // Hit zombies
      for (const z of zombiesRef.current) {
        if (b.life <= 0) break;
        if (dist(b.x, b.y, z.x, z.y) < ZOMBIE_RADIUS + BULLET_RADIUS) {
          b.life = 0;
          z.hp -= 1;
          spawnBlood(z.x, z.y, 6);
          if (z.hp <= 0) {
            spawnBlood(z.x, z.y, 16);
            scoreRef.current += 100;
            killCountRef.current += 1;
            setScore(scoreRef.current);
            setKillCount(killCountRef.current);
          }
        }
      }
    }

    // Remove dead bullets
    bulletsRef.current = bulletsRef.current.filter(b => b.life > 0);

    // Remove dead zombies
    const prevCount = zombiesRef.current.length;
    zombiesRef.current = zombiesRef.current.filter(z => z.hp > 0);
    if (zombiesRef.current.length !== prevCount) {
      // Check win condition
      if (zombiesRef.current.length === 0) {
        const finalScore = scoreRef.current + player.hp * 50;
        scoreRef.current = finalScore;
        updateHighScore(finalScore);
        setScore(finalScore);
        phaseRef.current = "won";
        setPhase("won");
        spawnConfetti();
        return;
      }
    }

    // ── Zombies AI ──────────────────────────────────────────────────────
    for (const z of zombiesRef.current) {
      const speed = z.type === "runner" ? ZOMBIE_SPEED_RUNNER : ZOMBIE_SPEED_WALKER;

      // Simple direct chase (zombies navigate toward player)
      const dx = player.x - z.x;
      const dy = player.y - z.y;
      const dlen = Math.sqrt(dx * dx + dy * dy);
      if (dlen > 0) {
        z.vx = lerp(z.vx, (dx / dlen) * speed, Math.min(1, dt * 4));
        z.vy = lerp(z.vy, (dy / dlen) * speed, Math.min(1, dt * 4));
        z.angle = Math.atan2(dy, dx);
      }

      z.x += z.vx * dt;
      const zPushX = resolveAABBvsTiles(grid, z.x, z.y, ZOMBIE_RADIUS);
      if (zPushX) {
        z.x += zPushX.dx;
        z.vx = -z.vx * 0.3;
        // Add perpendicular nudge to help navigate around corners
        z.vy += randomInRange(-30, 30);
      }

      z.y += z.vy * dt;
      const zPushY = resolveAABBvsTiles(grid, z.x, z.y, ZOMBIE_RADIUS);
      if (zPushY) {
        z.y += zPushY.dy;
        z.vy = -z.vy * 0.3;
        z.vx += randomInRange(-30, 30);
      }

      // Zombie-zombie separation
      for (const other of zombiesRef.current) {
        if (other.id === z.id) continue;
        const sdx = z.x - other.x;
        const sdy = z.y - other.y;
        const sd = Math.sqrt(sdx * sdx + sdy * sdy);
        if (sd < ZOMBIE_RADIUS * 2 && sd > 0) {
          z.vx += (sdx / sd) * 60;
          z.vy += (sdy / sd) * 60;
        }
      }

      // Attack player
      z.attackCooldown = Math.max(0, z.attackCooldown - dt);
      if (dist(z.x, z.y, player.x, player.y) < ZOMBIE_ATTACK_RANGE && z.attackCooldown <= 0) {
        z.attackCooldown = ZOMBIE_ATTACK_COOLDOWN;
        if (player.invincible <= 0) {
          player.hp -= ZOMBIE_DAMAGE;
          player.invincible = INVINCIBLE_TIME;
          spawnBlood(player.x, player.y, 4);
          if (player.hp <= 0) {
            phaseRef.current = "dead";
            setPhase("dead");
            spawnConfetti();
            return;
          }
        }
      }
    }

    // ── Particles ──────────────────────────────────────────────────────
    for (const p of particlesRef.current) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.92;
      p.vy *= 0.92;
      p.life -= dt;
    }
    particlesRef.current = particlesRef.current.filter(p => p.life > 0);

    // ── Camera ─────────────────────────────────────────────────────────
    const mazeW = MAZE_COLS * TILE;
    const mazeH = MAZE_ROWS * TILE;
    const targetCamX = clamp(player.x - w / 2, 0, Math.max(0, mazeW - w));
    const targetCamY = clamp(player.y - h / 2, 0, Math.max(0, mazeH - h));
    cam.x = lerp(cam.x, targetCamX, Math.min(1, dt * 8));
    cam.y = lerp(cam.y, targetCamY, Math.min(1, dt * 8));

    // ── Render ─────────────────────────────────────────────────────────
    renderGame(ctx, w, h, player, grid, cam);
  }, paused);

  // ── Render functions ─────────────────────────────────────────────────

  function renderGame(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    player: Player,
    grid: number[][],
    cam: { x: number; y: number }
  ) {
    // Background
    ctx.fillStyle = "#1a1a2e";
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(-cam.x, -cam.y);

    // Draw maze tiles
    const tileLeft = Math.max(0, Math.floor(cam.x / TILE));
    const tileRight = Math.min(MAZE_COLS - 1, Math.ceil((cam.x + w) / TILE));
    const tileTop = Math.max(0, Math.floor(cam.y / TILE));
    const tileBottom = Math.min(MAZE_ROWS - 1, Math.ceil((cam.y + h) / TILE));

    for (let ty = tileTop; ty <= tileBottom; ty++) {
      for (let tx = tileLeft; tx <= tileRight; tx++) {
        const px = tx * TILE;
        const py = ty * TILE;
        if (isWall(grid, tx, ty)) {
          // Wall
          ctx.fillStyle = "#2d3561";
          ctx.fillRect(px, py, TILE, TILE);
          // Wall top highlight
          ctx.fillStyle = "#3d4a7a";
          ctx.fillRect(px, py, TILE, 3);
          ctx.fillRect(px, py, 3, TILE);
          // Wall border
          ctx.strokeStyle = "#1a1f3c";
          ctx.lineWidth = 1;
          ctx.strokeRect(px, py, TILE, TILE);
        } else {
          // Floor
          ctx.fillStyle = "#16213e";
          ctx.fillRect(px, py, TILE, TILE);
          // Floor grid lines
          ctx.strokeStyle = "#1e2a4a";
          ctx.lineWidth = 0.5;
          ctx.strokeRect(px, py, TILE, TILE);
        }
      }
    }

    // Draw particles
    for (const p of particlesRef.current) {
      const alpha = clamp(p.life / p.maxLife, 0, 1);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Draw bullets
    for (const b of bulletsRef.current) {
      drawGlow(ctx, b.x, b.y, 14, "#ffee44");
      ctx.fillStyle = "#ffffaa";
      ctx.beginPath();
      ctx.arc(b.x, b.y, BULLET_RADIUS, 0, Math.PI * 2);
      ctx.fill();
    }

    // Draw zombies
    for (const z of zombiesRef.current) {
      const isRunner = z.type === "runner";
      const bodyColor = isRunner ? "#ff4444" : "#44aa44";
      const darkColor = isRunner ? "#cc2222" : "#2d7a2d";

      // Shadow
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = "#000";
      ctx.beginPath();
      ctx.ellipse(z.x, z.y + ZOMBIE_RADIUS - 2, ZOMBIE_RADIUS * 0.9, ZOMBIE_RADIUS * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      // Body
      ctx.save();
      ctx.translate(z.x, z.y);
      ctx.rotate(z.angle);

      ctx.fillStyle = bodyColor;
      ctx.beginPath();
      ctx.arc(0, 0, ZOMBIE_RADIUS, 0, Math.PI * 2);
      ctx.fill();

      // Zombie face
      ctx.fillStyle = darkColor;
      ctx.beginPath();
      ctx.arc(ZOMBIE_RADIUS * 0.35, -ZOMBIE_RADIUS * 0.2, 2.5, 0, Math.PI * 2); // eye
      ctx.fill();
      ctx.beginPath();
      ctx.arc(ZOMBIE_RADIUS * 0.35, ZOMBIE_RADIUS * 0.2, 2.5, 0, Math.PI * 2); // eye
      ctx.fill();

      // Arms
      ctx.strokeStyle = bodyColor;
      ctx.lineWidth = 4;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(0, -ZOMBIE_RADIUS * 0.5);
      ctx.lineTo(ZOMBIE_RADIUS + 5, -ZOMBIE_RADIUS * 0.7);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, ZOMBIE_RADIUS * 0.5);
      ctx.lineTo(ZOMBIE_RADIUS + 5, ZOMBIE_RADIUS * 0.7);
      ctx.stroke();

      ctx.restore();

      // HP bar
      if (z.hp < z.maxHp) {
        const bw = 24;
        const bh = 4;
        ctx.fillStyle = "#333";
        ctx.fillRect(z.x - bw / 2, z.y - ZOMBIE_RADIUS - 8, bw, bh);
        ctx.fillStyle = "#44ff44";
        ctx.fillRect(z.x - bw / 2, z.y - ZOMBIE_RADIUS - 8, bw * (z.hp / z.maxHp), bh);
      }
    }

    // Draw player
    if (player.hp > 0) {
      // Shadow
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = "#000";
      ctx.beginPath();
      ctx.ellipse(player.x, player.y + PLAYER_RADIUS - 2, PLAYER_RADIUS * 0.9, PLAYER_RADIUS * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      // Invincibility flash
      if (player.invincible > 0 && Math.floor(player.invincible * 10) % 2 === 0) {
        ctx.globalAlpha = 0.4;
      }

      ctx.save();
      ctx.translate(player.x, player.y);
      ctx.rotate(player.angle);

      // Player glow
      drawGlow(ctx, 0, 0, 28, "#4488ff");

      // Body
      ctx.fillStyle = "#3399ff";
      ctx.beginPath();
      ctx.arc(0, 0, PLAYER_RADIUS, 0, Math.PI * 2);
      ctx.fill();

      // Gun
      ctx.fillStyle = "#aaaacc";
      ctx.fillRect(PLAYER_RADIUS - 2, -3, 12, 6);

      // Eyes
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(PLAYER_RADIUS * 0.4, -3.5, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(PLAYER_RADIUS * 0.4, 3.5, 2.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
      ctx.globalAlpha = 1;
    }

    ctx.restore();

    // ── HUD ─────────────────────────────────────────────────────────────
    // HP bar
    const hpW = 120;
    const hpH = 14;
    const hpX = 12;
    const hpY = h - 30;
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.beginPath();
    ctx.roundRect(hpX - 2, hpY - 2, hpW + 4, hpH + 4, 4);
    ctx.fill();
    ctx.fillStyle = "#333";
    ctx.fillRect(hpX, hpY, hpW, hpH);
    const hpFrac = clamp(player.hp / player.maxHp, 0, 1);
    const hpColor = hpFrac > 0.5 ? "#44ff44" : hpFrac > 0.25 ? "#ffaa00" : "#ff3333";
    ctx.fillStyle = hpColor;
    ctx.fillRect(hpX, hpY, hpW * hpFrac, hpH);
    drawText(ctx, `❤ ${player.hp}/${player.maxHp}`, hpX + hpW / 2, hpY + hpH / 2, { font: "11px Manrope", color: "#fff" });

    // Zombie counter
    drawText(ctx, `☠ ${killCountRef.current} / ${ZOMBIE_COUNT}`, w - 70, h - 22, {
      font: "bold 14px Manrope", color: "#ffcc44",
      shadow: "#000", shadowBlur: 6,
    });

    // Touch joystick indicator
    if (joystickRef.current.active) {
      const jx = joystickRef.current.startX;
      const jy = joystickRef.current.startY;
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(jx, jy, 44, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(jx + joystickRef.current.dx * 44, jy + joystickRef.current.dy * 44, 20, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Controls hint (first few seconds or when no movement)
    drawText(ctx, "WASD/Arrows: Move  |  Mouse/Click: Aim & Shoot  |  Space: Shoot", w / 2, h - 10, {
      font: "10px Manrope", color: "rgba(255,255,255,0.4)",
    });
  }

  function renderWinOrDead(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const isWon = phaseRef.current === "won";

    // Dark overlay
    ctx.fillStyle = isWon ? "rgba(0,20,0,0.88)" : "rgba(20,0,0,0.88)";
    ctx.fillRect(0, 0, w, h);

    // Confetti
    for (const p of confettiRef.current) {
      const alpha = clamp(p.life / p.maxLife, 0, 1);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.life * 5);
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
      ctx.restore();
    }
    ctx.globalAlpha = 1;

    if (isWon) {
      // 🏆 WINNER sign
      const cx = w / 2;
      const cy = h / 2 - 40;

      // Trophy glow
      drawGlow(ctx, cx, cy - 20, 120, "#ffdd00");

      // Card background
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.beginPath();
      ctx.roundRect(cx - 200, cy - 90, 400, 220, 20);
      ctx.fill();
      ctx.strokeStyle = "#ffdd00";
      ctx.lineWidth = 3;
      ctx.stroke();

      // Trophy emoji
      drawText(ctx, "🏆", cx, cy - 40, { font: "64px serif", color: "#fff" });

      // WINNER text
      drawText(ctx, "YOU WIN!", cx, cy + 40, {
        font: "bold 48px Fraunces, serif",
        color: "#ffdd00",
        shadow: "#ff8800",
        shadowBlur: 20,
      });

      // Score
      drawText(ctx, `Score: ${scoreRef.current}`, cx, cy + 90, {
        font: "bold 22px Manrope",
        color: "#ffffff",
        shadow: "#000",
        shadowBlur: 8,
      });

      drawText(ctx, `Zombies Slain: ${killCountRef.current}`, cx, cy + 118, {
        font: "16px Manrope",
        color: "#aaffaa",
        shadow: "#000",
        shadowBlur: 6,
      });
    } else {
      // Dead screen
      const cx = w / 2;
      const cy = h / 2 - 30;

      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.beginPath();
      ctx.roundRect(cx - 180, cy - 80, 360, 200, 20);
      ctx.fill();
      ctx.strokeStyle = "#ff3333";
      ctx.lineWidth = 3;
      ctx.stroke();

      drawText(ctx, "💀", cx, cy - 20, { font: "56px serif", color: "#fff" });

      drawText(ctx, "YOU DIED", cx, cy + 40, {
        font: "bold 44px Fraunces, serif",
        color: "#ff3333",
        shadow: "#880000",
        shadowBlur: 20,
      });

      drawText(ctx, `Zombies killed: ${killCountRef.current} / ${ZOMBIE_COUNT}`, cx, cy + 82, {
        font: "16px Manrope", color: "#ffaaaa",
      });
    }

    // Play again button
    const btnW = 180, btnH = 50;
    const btnX = w / 2 - btnW / 2;
    const btnY = h / 2 + (isWon ? 100 : 90);

    ctx.fillStyle = isWon ? "#22aa44" : "#aa2222";
    ctx.beginPath();
    ctx.roundRect(btnX, btnY, btnW, btnH, 12);
    ctx.fill();
    ctx.strokeStyle = isWon ? "#44ff88" : "#ff4444";
    ctx.lineWidth = 2;
    ctx.stroke();

    drawText(ctx, "Play Again", w / 2, btnY + btnH / 2, {
      font: "bold 20px Manrope",
      color: "#ffffff",
      shadow: "#000",
      shadowBlur: 6,
    });
  }

  // Click "Play Again"
  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (phase !== "playing") {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const { w, h } = canvasSizeRef.current;
      const isWon = phase === "won";
      const btnW = 180, btnH = 50;
      const btnX = w / 2 - btnW / 2;
      const btnY = h / 2 + (isWon ? 100 : 90);
      const rx = e.clientX - canvas.getBoundingClientRect().left;
      const ry = e.clientY - canvas.getBoundingClientRect().top;
      if (rx >= btnX && rx <= btnX + btnW && ry >= btnY && ry <= btnY + btnH) {
        initGame();
      }
    }
  }, [phase, initGame]);

  return (
    <GameShell topbar={<GameTopbar title="Zombie Maze" score={score} />}>
      <div ref={containerRef} className="w-full h-full relative overflow-hidden">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full"
          onClick={handleCanvasClick}
          style={{ cursor: phase === "playing" ? "crosshair" : "default", touchAction: "none" }}
        />
      </div>
    </GameShell>
  );
}
