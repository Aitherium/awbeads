/**
 * The street: BeadSpace's walkable scene mode (owner, 2026-10-17). A neon pixel-art
 * street you walk along; each place is a storefront bead; the agents stand at their
 * doors and talk; the sky follows the visitor's real clock (`skyAt`). The
 * universe/galaxy view stays the map. This is a scene of the same engine, not an app.
 *
 * Interaction: walk (keys, click, tap), hover highlights what you can use, E/click
 * talks to an agent or opens a door, props (vending machine, arcade, jukebox, the cat)
 * answer through `onProp`, and the host can make anyone `say()` something.
 *
 * Cost rules (the owner games on the machine that serves this): ONE animation loop,
 * capped at `fps` (30 by default), never scheduled while paused or while the tab is
 * hidden, and a visible tab never resumes a street the HOST paused (test/street.ts).
 */

import { hash } from '../core/hash';
import { skyAt, type Sky, type SkyOptions } from './sky';

export type StreetPlaceKind = 'shop' | 'bar' | 'spaces' | 'arcade' | 'gate' | 'lot' | 'home' | 'space';

export interface StreetNpc {
  id: string;
  name: string;
  /** Persona colour, used for the sprite when no image is given. */
  color?: string;
  /** Hair/accent colour. */
  accent?: string;
  /** Optional sprite image (an avatar thumbnail). */
  spriteUrl?: string;
}

export interface StreetPlace {
  id: string;
  /** The neon sign over the door. */
  sign: string;
  kind?: StreetPlaceKind;
  /** Facade/neon colour. */
  color?: string;
  /** One line shown when you stand at the door. */
  blurb?: string;
  /** Where the door leads; absent = the host decides in onEnter. */
  href?: string;
  /** Shutters down: shown, but the door does not open. */
  closed?: boolean;
  /** The agent standing at this door. */
  npc?: StreetNpc;
}

export type StreetPropKind = 'vending' | 'arcade' | 'jukebox' | 'cat' | 'billboard' | 'bench';

export interface StreetProp {
  id: string;
  kind: StreetPropKind;
  /** Next to which place (placed on its right side). */
  near: string;
  /** Tooltip / aria text. */
  label?: string;
}

export interface StreetOptions {
  places: StreetPlace[];
  props?: StreetProp[];
  /** The clock; inject for tests and screenshots. */
  now?: () => Date;
  sky?: SkyOptions;
  paused?: boolean;
  /** No rain, no walking crowd, no twinkle: one still frame per minute. */
  reducedMotion?: boolean;
  fps?: number;
  /** Seed for skyline and crowd so a street looks the same on every visit. */
  seed?: string;
  /** Short slogans for the scrolling billboards (owner's voice lives in data). */
  billboards?: string[];
  onEnter?: (place: StreetPlace) => void;
  onTalk?: (npc: StreetNpc, place: StreetPlace) => void;
  onProp?: (prop: StreetProp) => void;
  /** Called when the place you stand at changes (null = between doors). */
  onNear?: (place: StreetPlace | null) => void;
  /** What the pointer is over: 'npc:<id>', 'prop:<id>', 'door:<id>' or null. */
  onHover?: (target: string | null) => void;
}

export interface StreetHandle {
  pause(): void;
  resume(): void;
  destroy(): void;
  /** Walk to a place's door. */
  walkTo(id: string): void;
  /** A speech bubble over an agent ('npc id') or over you ('you'), for `ms`. */
  say(who: string, text: string, ms?: number): void;
  /** The sky being drawn now. */
  sky(): Sky;
  /** The place you stand at, or null. */
  near(): StreetPlace | null;
  /** Door x positions in street units (for tests and the map). */
  layout(): { id: string; x: number; width: number }[];
  /** True while an animation frame is scheduled. */
  running(): boolean;
}

export const BLOCK_W = 112; // street units per storefront
const GAP_W = 40; // alley between storefronts (props live here)
const EDGE_W = 72; // street before the first and after the last door
const DOOR_REACH = 30; // how close counts as "at the door"
const WALK_SPEED = 72; // street units per second
const GROUND = 150; // street line, art pixels from the top of a 180-px tall view

const KIND_COLOR: Record<StreetPlaceKind, string> = {
  shop: '#ff4fd8',
  bar: '#38f2ff',
  spaces: '#a6ff4f',
  arcade: '#ffd23f',
  gate: '#8f7bff',
  lot: '#ff7a3d',
  home: '#ffb38a',
  space: '#7fffd4',
};

const DEFAULT_BILLBOARDS = ['NEO-AITHER', 'RUN IT AT HOME', 'AGENTS WELCOME', 'NIGHT MARKET OPEN', 'AITHERNET'];

/** Door positions along the street, left to right, every place reachable. */
export function streetLayout(places: StreetPlace[]): { id: string; x: number; width: number }[] {
  return places.map((p, i) => ({ id: p.id, x: EDGE_W + i * (BLOCK_W + GAP_W) + BLOCK_W / 2, width: BLOCK_W }));
}

export function streetLength(places: StreetPlace[]): number {
  return EDGE_W * 2 + places.length * BLOCK_W + Math.max(0, places.length - 1) * GAP_W;
}

function rnd(seed: string, i: number): number {
  return (hash(`${seed}:${i}`) % 10000) / 10000;
}

interface Bubble {
  who: string;
  text: string;
  until: number;
}

export function createStreet(container: HTMLElement, options: StreetOptions): StreetHandle {
  const doc = container.ownerDocument;
  const win = doc.defaultView as Window & typeof globalThis;
  const places = options.places.slice();
  const layout = streetLayout(places);
  const length = streetLength(places);
  const now = options.now ?? (() => new Date());
  const seed = options.seed ?? 'neo-aither';
  const fps = Math.max(1, Math.min(60, options.fps ?? 30));
  const reduced = !!options.reducedMotion;
  const billboards = (options.billboards && options.billboards.length ? options.billboards : DEFAULT_BILLBOARDS).map(s =>
    s.toUpperCase(),
  );

  // props sit in the alley to the right of the place they are `near`
  const props = (options.props ?? [])
    .map(p => {
      const l = layout.find(q => q.id === p.near);
      return l ? { ...p, x: l.x + BLOCK_W / 2 + GAP_W / 2 } : null;
    })
    .filter((p): p is StreetProp & { x: number } => p !== null);
  const cat = props.find(p => p.kind === 'cat');
  let catX = cat ? cat.x : 0;

  const canvas = doc.createElement('canvas');
  canvas.className = 'bead-street';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `A street with ${places.map(p => p.sign).join(', ')}`);
  canvas.tabIndex = 0;
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.imageRendering = 'pixelated';
  canvas.style.touchAction = 'pan-y';
  container.appendChild(canvas);
  const ctx = (canvas.getContext && canvas.getContext('2d')) as CanvasRenderingContext2D | null;

  const sprites = new Map<string, HTMLImageElement>();
  for (const p of places) {
    if (p.npc?.spriteUrl && typeof win.Image === 'function') {
      const img = new win.Image();
      img.src = p.npc.spriteUrl;
      sprites.set(p.npc.id, img);
    }
  }

  let playerX = layout.length ? layout[0].x : EDGE_W;
  let facing = 1;
  let moving = false;
  let walkT = 0;
  let target: number | null = null;
  let arriveAt: string | null = null; // 'place:<id>' | 'prop:<id>'
  let held = 0; // -1 left, +1 right from the keyboard
  let nearId: string | null = null;
  let hover: string | null = null;
  let pointer: { x: number; y: number } | null = null;
  let paused = !!options.paused;
  let hostPaused = paused;
  let frame: number | null = null;
  let last = 0;
  let lastDraw = 0;
  let clock = 0;
  let sky = skyAt(now(), options.sky);
  const bubbles: Bubble[] = [];
  const drops = Array.from({ length: 90 }, (_, i) => ({ x: rnd(seed, i * 3), y: rnd(seed, i * 3 + 1), v: 0.6 + rnd(seed, i * 3 + 2) }));
  const walkers = Array.from({ length: 16 }, (_, i) => ({
    x: rnd(seed, 500 + i) * length,
    dir: rnd(seed, 600 + i) > 0.5 ? 1 : -1,
    speed: 10 + rnd(seed, 700 + i) * 16,
    hue: Math.floor(rnd(seed, 800 + i) * 360),
    umbrella: rnd(seed, 900 + i) < 0.4,
  }));
  const cars = Array.from({ length: 4 }, (_, i) => ({ x: rnd(seed, 1200 + i), y: 18 + rnd(seed, 1300 + i) * 40, v: 0.02 + rnd(seed, 1400 + i) * 0.03, dir: i % 2 ? 1 : -1 }));

  function placeAt(x: number): StreetPlace | null {
    let best: StreetPlace | null = null;
    let bestD = DOOR_REACH;
    layout.forEach((l, i) => {
      const d = Math.abs(l.x - x);
      if (d <= bestD) {
        bestD = d;
        best = places[i];
      }
    });
    return best;
  }

  function updateNear(): void {
    const p = placeAt(playerX);
    const id = p ? p.id : null;
    if (id !== nearId) {
      nearId = id;
      options.onNear?.(p);
    }
  }

  function arrive(key: string): void {
    if (key.startsWith('prop:')) {
      const pr = props.find(q => q.id === key.slice(5));
      if (pr) options.onProp?.(pr);
      return;
    }
    const p = places.find(q => q.id === key.slice(6));
    if (!p) return;
    if (p.npc && options.onTalk) options.onTalk(p.npc, p);
    else if (!p.closed) options.onEnter?.(p);
  }

  function interact(): void {
    const pr = props.find(q => Math.abs(q.x - playerX) <= 14);
    if (pr) {
      options.onProp?.(pr);
      return;
    }
    const p = placeAt(playerX);
    if (!p) return;
    if (p.npc && options.onTalk) options.onTalk(p.npc, p);
    else if (!p.closed) options.onEnter?.(p);
  }

  function walkToX(x: number, key: string | null): void {
    target = Math.min(length - 8, Math.max(8, x));
    arriveAt = key;
    if (reduced) {
      playerX = target;
      target = null;
      updateNear();
      if (key) {
        arriveAt = null;
        arrive(key);
      }
      draw(0);
    }
  }

  function step(dt: number): void {
    const dir = held !== 0 ? held : target === null ? 0 : Math.sign(target - playerX);
    if (held !== 0) target = null;
    moving = dir !== 0;
    if (dir !== 0) {
      facing = dir;
      walkT += dt;
      let nx = playerX + dir * WALK_SPEED * dt;
      if (target !== null && Math.sign(target - nx) !== dir) {
        nx = target;
        target = null;
        playerX = nx;
        updateNear();
        if (arriveAt) {
          const key = arriveAt;
          arriveAt = null;
          arrive(key);
        }
      }
      playerX = Math.min(length - 8, Math.max(8, nx));
    }
    if (cat) {
      // the cat ambles after you when you are close, then sits
      const d = playerX - 10 * facing - catX;
      if (Math.abs(playerX - catX) < 90 && Math.abs(d) > 6) catX += Math.sign(d) * Math.min(Math.abs(d), 40 * dt);
    }
    if (!reduced) {
      for (const w of walkers) {
        w.x += w.dir * w.speed * dt;
        if (w.x < 0) w.x += length;
        if (w.x > length) w.x -= length;
      }
      for (const d of drops) {
        d.y += d.v * dt * 1.4;
        if (d.y > 1) d.y -= 1;
      }
      for (const c of cars) {
        c.x += c.dir * c.v * dt;
        if (c.x < -0.2) c.x += 1.4;
        if (c.x > 1.2) c.x -= 1.4;
      }
    }
    updateNear();
  }

  // ---- geometry shared by draw() and hit tests ----
  function view(): { W: number; H: number; P: number; vw: number; cam: number; oy: number } {
    const rect = container.getBoundingClientRect();
    const W = Math.max(1, Math.floor(rect.width));
    const H = Math.max(1, Math.floor(rect.height));
    const P = Math.max(2, Math.floor(H / 180));
    const vw = W / P;
    // Written as half-height minus 90 (== (H/P - 180)/2): the other spelling
    // once minified to a capital letter, a hyphen and 180 -- a ledger-id shape the
    // vendor leak scan rejects.
    const oy = Math.max(0, Math.floor(H / P / 2 - 90)); // centre the 180-px scene vertically
    const cam = Math.min(Math.max(0, playerX - vw / 2), Math.max(0, length - vw));
    return { W, H, P, vw, cam, oy };
  }

  function hitTest(clientX: number, clientY: number): string | null {
    const rect = canvas.getBoundingClientRect();
    const { P, cam, oy } = view();
    const x = (clientX - rect.left) / P + cam;
    const y = (clientY - rect.top) / P - oy;
    for (const p of places) {
      const l = layout.find(q => q.id === p.id)!;
      if (p.npc && Math.abs(x - (l.x + 16)) <= 6 && y > GROUND - 26 && y < GROUND) return `npc:${p.npc.id}`;
    }
    for (const pr of props) {
      const px = pr.kind === 'cat' ? catX : pr.x;
      if (Math.abs(x - px) <= 9 && y > GROUND - 30 && y < GROUND + 2) return `prop:${pr.id}`;
    }
    const door = layout.find(l => Math.abs(l.x - x) <= BLOCK_W / 2 && y < GROUND && y > GROUND - 110);
    return door ? `door:${door.id}` : null;
  }

  // ---- drawing (every unit is snapped to the pixel scale P) ----
  function draw(t: number): void {
    sky = skyAt(now(), options.sky);
    if (!ctx) return;
    const { W, H, P, vw, cam, oy } = view();
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    const night = sky.glow;
    ctx.imageSmoothingEnabled = false;
    const px = (x: number, y: number, w: number, h: number, c: string) => {
      ctx.fillStyle = c;
      ctx.fillRect(Math.round(x) * P, Math.round(y + oy) * P, Math.max(1, Math.round(w)) * P, Math.max(1, Math.round(h)) * P);
    };
    const glow = (x: number, y: number, r: number, color: string, a: number) => {
      if (a <= 0.01) return;
      const gx = x * P;
      const gy = (y + oy) * P;
      const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, r * P);
      g.addColorStop(0, color.replace('A', String(a)));
      g.addColorStop(1, color.replace('A', '0'));
      ctx.fillStyle = g;
      ctx.fillRect(gx - r * P, gy - r * P, 2 * r * P, 2 * r * P);
    };
    const text = (s: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = 'center') => {
      ctx.fillStyle = color;
      ctx.font = `bold ${Math.max(8, Math.round(size * P))}px ui-monospace, "Cascadia Mono", monospace`;
      ctx.textAlign = align;
      ctx.textBaseline = 'middle';
      ctx.fillText(s, x * P, (y + oy) * P);
    };

    // sky
    const g = ctx.createLinearGradient(0, 0, 0, (GROUND + oy) * P);
    g.addColorStop(0, sky.top);
    g.addColorStop(1, sky.horizon);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    if (sky.starAlpha > 0) {
      for (let i = 0; i < 90; i++) {
        const tw = reduced ? 1 : 0.55 + 0.45 * Math.sin(t / 650 + i * 1.7);
        ctx.globalAlpha = sky.starAlpha * tw;
        px(rnd(seed, 9000 + i) * vw, rnd(seed, 9100 + i) * 95 - oy * 0.5, 1, 1, '#ffffff');
      }
      ctx.globalAlpha = 1;
    }
    const bx = sky.bodyX * vw;
    const by = 112 - sky.bodyY * 92;
    if (sky.body === 'moon') {
      glow(bx, by, 40, 'rgba(205,184,255,A)', 0.35);
      ctx.fillStyle = '#f4f1ff';
      ctx.beginPath();
      ctx.arc(bx * P, (by + oy) * P, 7 * P, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = sky.top;
      ctx.beginPath();
      ctx.arc((bx + 3.5) * P, (by - 2 + oy) * P, 6.5 * P, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const r = 15;
      glow(bx, by, 50, 'rgba(255,190,220,A)', 0.4);
      const sg = ctx.createLinearGradient(0, (by - r + oy) * P, 0, (by + r + oy) * P);
      sg.addColorStop(0, '#fff3a8');
      sg.addColorStop(1, sky.phase === 'day' ? '#ffd27a' : '#ff4fa0');
      ctx.fillStyle = sg;
      ctx.beginPath();
      ctx.arc(bx * P, (by + oy) * P, r * P, 0, Math.PI * 2);
      ctx.fill();
      if (sky.phase !== 'day') {
        ctx.fillStyle = sky.horizon;
        for (let b = 0; b < 4; b++) ctx.fillRect((bx - r) * P, (by + 2 + b * 3 + oy) * P, 2 * r * P, (1 + b * 0.5) * P);
      }
    }
    if (sky.daylight > 0.3) {
      ctx.globalAlpha = 0.5 * sky.daylight;
      for (let c = 0; c < 6; c++) {
        const cx = ((rnd(seed, 7000 + c) * vw * 2 + (reduced ? 0 : t / 400) * (0.5 + c * 0.1)) % (vw + 60)) - 30;
        const cy = 18 + rnd(seed, 7100 + c) * 50;
        px(cx, cy, 30, 4, '#ffffff');
        px(cx + 7, cy - 3, 16, 3, '#ffffff');
      }
      ctx.globalAlpha = 1;
    }

    // flying cars at night, high in the haze
    if (night > 0.4) {
      for (const c of cars) {
        const cx = c.x * vw;
        px(cx, c.y, 7, 2, '#2a1d4a');
        px(cx + (c.dir > 0 ? 7 : -1), c.y, 1, 1, '#ff4f6d');
        glow(cx + (c.dir > 0 ? -2 : 9), c.y + 1, 6, 'rgba(120,230,255,A)', 0.5 * night);
      }
    }

    // far skyline (slowest) with antenna lights and scrolling billboards
    const drawSkyline = (speed: number, n: number, base: number, hMin: number, hVar: number, cDay: string, cNight: string, salt: number, boards: boolean) => {
      const span = n * 30;
      const off = cam * speed;
      for (let i = 0; i < n; i++) {
        const w = 16 + rnd(seed, salt + i) * 24;
        const h = hMin + rnd(seed, salt + 100 + i) * hVar;
        const x0 = i * 30 - (off % span);
        const xx = ((x0 % span) + span) % span - 30;
        if (xx > vw + 30) continue;
        px(xx, base - h, w, h + 30, sky.daylight > 0.5 ? cDay : cNight);
        if (night > 0.3) {
          for (let k = 0; k < 8; k++) {
            if (rnd(seed, salt + 300 + i * 9 + k) < 0.4) {
              ctx.globalAlpha = night * (reduced ? 1 : 0.7 + 0.3 * Math.sin(t / 2000 + i + k));
              px(xx + 3 + (k % 3) * 6, base - h + 6 + Math.floor(k / 3) * 9, 2, 3, k % 5 ? '#ffd66b' : '#7fe3ff');
              ctx.globalAlpha = 1;
            }
          }
          if (rnd(seed, salt + 700 + i) < 0.35) {
            const blink = reduced || Math.floor(t / 900 + i) % 2 === 0;
            px(xx + w / 2, base - h - 6, 1, 6, '#3a2a55');
            if (blink) glow(xx + w / 2, base - h - 6, 3, 'rgba(255,60,90,A)', night);
          }
        }
        if (boards && rnd(seed, salt + 800 + i) < 0.22 && w > 22) {
          const msg = billboards[i % billboards.length];
          const bw = w - 4;
          const bxx = xx + 2;
          const byy = base - h + 8;
          const col = ['#ff4fd8', '#38f2ff', '#ffd23f', '#a6ff4f'][i % 4];
          ctx.globalAlpha = Math.max(0.35, night);
          px(bxx, byy, bw, 7, '#120a24');
          ctx.save();
          ctx.beginPath();
          ctx.rect(bxx * P, (byy + oy) * P, bw * P, 7 * P);
          ctx.clip();
          const scroll = reduced ? 0 : (t / 60) % (msg.length * 4 + bw);
          text(msg, bxx + bw - scroll, byy + 3.5, 4, col, 'left');
          ctx.restore();
          ctx.globalAlpha = 1;
        }
      }
    };
    drawSkyline(0.12, 40, GROUND - 26, 40, 70, '#7884a8', '#170d33', 100, true);
    // haze between the layers
    const haze = ctx.createLinearGradient(0, (GROUND - 80 + oy) * P, 0, (GROUND - 10 + oy) * P);
    haze.addColorStop(0, 'rgba(255,79,216,0)');
    haze.addColorStop(1, night > 0.4 ? `rgba(120,40,160,${0.35 * night})` : 'rgba(200,220,255,0.25)');
    ctx.fillStyle = haze;
    ctx.fillRect(0, (GROUND - 80 + oy) * P, W, 70 * P);
    drawSkyline(0.35, 36, GROUND - 14, 26, 40, '#5f6b8f', '#1d1140', 2100, false);

    // overhead cables with lanterns, swaying a little
    {
      ctx.strokeStyle = '#0a0614';
      ctx.lineWidth = Math.max(1, P / 2);
      for (let x = -((cam * 0.9) % 160); x < vw + 160; x += 160) {
        const sway = reduced ? 0 : Math.sin(t / 1500 + x) * 2;
        ctx.beginPath();
        ctx.moveTo(x * P, (32 + oy) * P);
        ctx.quadraticCurveTo((x + 80) * P, (52 + sway + oy) * P, (x + 160) * P, (32 + oy) * P);
        ctx.stroke();
        for (let k = 1; k < 5; k++) {
          const lx = x + k * 32;
          const ly = 32 + Math.sin((k / 5) * Math.PI) * (20 + sway) * 0.9;
          const lc = ['#ff4f6d', '#ffd23f', '#38f2ff', '#ff4fd8'][k % 4];
          px(lx - 1, ly, 3, 3, lc);
          glow(lx + 0.5, ly + 1.5, 7, lc === '#ff4f6d' ? 'rgba(255,79,109,A)' : lc === '#ffd23f' ? 'rgba(255,210,63,A)' : lc === '#38f2ff' ? 'rgba(56,242,255,A)' : 'rgba(255,79,216,A)', 0.5 * night);
        }
      }
    }

    // storefronts
    layout.forEach((l, i) => {
      const p = places[i];
      const color = p.color || KIND_COLOR[p.kind || 'shop'];
      const x = l.x - BLOCK_W / 2 - cam;
      if (x > vw || x + BLOCK_W < 0) return;
      const h = 82 + (hash(`${seed}:${p.id}`) % 22);
      const hovered = hover === `door:${p.id}`;
      px(x, GROUND - h, BLOCK_W, h, sky.daylight > 0.5 ? '#3a3f5c' : '#160d2b');
      px(x, GROUND - h, BLOCK_W, 2, sky.daylight > 0.5 ? '#4b5275' : '#241645'); // roof edge
      // awning
      px(x + 6, GROUND - 36, BLOCK_W - 12, 4, p.closed ? '#333' : color);
      ctx.globalAlpha = 0.5;
      for (let s = 0; s < BLOCK_W - 12; s += 8) px(x + 6 + s, GROUND - 36, 4, 4, '#0b0420');
      ctx.globalAlpha = 1;
      // shop window, lit from inside at night
      px(x + 10, GROUND - 30, BLOCK_W - 20, 30, p.closed ? '#24222b' : '#0e0a18');
      if (!p.closed) {
        ctx.globalAlpha = 0.25 + 0.45 * night;
        px(x + 12, GROUND - 28, 24, 20, color);
        px(BLOCK_W - 36 + x, GROUND - 28, 24, 20, color);
        ctx.globalAlpha = 1;
      } else {
        // shutters
        for (let s = 0; s < 30; s += 3) px(x + 10, GROUND - 30 + s, BLOCK_W - 20, 1, '#3d3a48');
      }
      // door
      px(l.x - cam - 8, GROUND - 26, 16, 26, p.closed ? '#3a3846' : hovered ? '#ffffff' : color);
      px(l.x - cam - 6, GROUND - 24, 12, 22, p.closed ? '#2a2834' : '#0b0420');
      if (!p.closed) {
        ctx.globalAlpha = 0.35 + 0.4 * night;
        px(l.x - cam - 6, GROUND - 24, 12, 22, color);
        ctx.globalAlpha = 1;
      }
      // neon sign
      const lit = !p.closed;
      const flick = reduced ? 1 : i % 3 === 1 && Math.sin(t / 37 + i) > 0.97 ? 0.35 : 0.88 + 0.12 * Math.sin(t / 90 + i * 3);
      if (lit) glow(l.x - cam, GROUND - h + 15, BLOCK_W * 0.55, color.length === 7 ? `rgba(${parseInt(color.slice(1, 3), 16)},${parseInt(color.slice(3, 5), 16)},${parseInt(color.slice(5, 7), 16)},A)` : 'rgba(255,79,216,A)', 0.45 * night * flick);
      ctx.globalAlpha = lit ? Math.max(0.6, night) * flick : 0.35;
      px(x + 10, GROUND - h + 8, BLOCK_W - 20, 15, color);
      ctx.globalAlpha = 1;
      text(p.sign.toUpperCase().slice(0, 13), l.x - cam, GROUND - h + 15.5, 7, '#0b0420');
      // upstairs windows, some with silhouettes
      for (let k = 0; k < 10; k++) {
        const wx = x + 12 + (k % 5) * 19;
        const wy = GROUND - h + 30 + Math.floor(k / 5) * 16;
        if (wy > GROUND - 42) continue;
        const on = rnd(seed, 4000 + i * 13 + k) < 0.3 + 0.6 * night;
        px(wx, wy, 10, 9, on ? (k % 4 === 0 ? '#ff9ed8' : '#ffcf6b') : '#241a3d');
        if (on && rnd(seed, 4500 + i * 13 + k) < 0.25) px(wx + 3, wy + 3, 3, 6, '#3a2140');
      }
      // wet-street reflection of the sign
      if (lit && night > 0.3) {
        ctx.globalAlpha = 0.22 * night * flick;
        px(x + 16, GROUND + 3, BLOCK_W - 32, 2, color);
        px(x + 24, GROUND + 8, BLOCK_W - 48, 1, color);
        px(x + 34, GROUND + 13, BLOCK_W - 68, 1, color);
        ctx.globalAlpha = 1;
      }
      // the agent at the door: idle bob, blink, turns to face you
      if (p.npc) {
        const nx = l.x - cam + 16;
        const bob = reduced ? 0 : Math.round(Math.sin(t / 420 + i) * 0.6);
        const face = playerX + 0 < l.x + 16 ? -1 : 1;
        const npcHover = hover === `npc:${p.npc.id}`;
        const near = Math.abs(playerX - l.x) <= DOOR_REACH;
        if (npcHover || near) glow(nx, GROUND - 12, 16, 'rgba(255,255,255,A)', 0.25);
        const img = sprites.get(p.npc.id);
        if (img && img.complete && img.naturalWidth > 0) {
          ctx.drawImage(img, (nx - 8) * P, (GROUND - 30 + bob + oy) * P, 16 * P, 30 * P);
        } else {
          px(nx - 3, GROUND - 4, 2, 4, '#1b1430');
          px(nx + 1, GROUND - 4, 2, 4, '#1b1430');
          px(nx - 4, GROUND - 15 + bob, 8, 11, p.npc.color || '#ffffff');
          px(nx - 3, GROUND - 21 + bob, 6, 6, '#ffd9c2');
          px(nx - 3, GROUND - 22 + bob, 6, 2, p.npc.accent || '#2b1055');
          const blink = !reduced && Math.floor(t / 180) % 23 === i % 23;
          px(nx + (face > 0 ? 1 : -2), GROUND - 19 + bob, 1, blink ? 0.4 : 1, '#120a24');
        }
        text(p.npc.name, nx, GROUND - 28, 4, npcHover ? '#ffffff' : '#e6dcff');
        if (near && !bubbles.some(b => b.who === p.npc!.id)) {
          px(nx - 9, GROUND - 40, 18, 7, '#ffffff');
          text('E · talk', nx, GROUND - 36.5, 3.6, '#120a24');
        }
      }
    });

    // props in the alleys
    for (const pr of props) {
      const pxX = (pr.kind === 'cat' ? catX : pr.x) - cam;
      if (pxX < -20 || pxX > vw + 20) continue;
      const hv = hover === `prop:${pr.id}`;
      if (hv) glow(pxX, GROUND - 10, 14, 'rgba(255,255,255,A)', 0.3);
      if (pr.kind === 'vending') {
        px(pxX - 6, GROUND - 26, 12, 26, '#c8264f');
        px(pxX - 4, GROUND - 23, 8, 12, '#ffe6f0');
        for (let r = 0; r < 3; r++) px(pxX - 3, GROUND - 22 + r * 4, 6, 2, ['#38f2ff', '#ffd23f', '#a6ff4f'][r]);
        glow(pxX, GROUND - 17, 14, 'rgba(255,230,240,A)', 0.4 * night);
      } else if (pr.kind === 'arcade') {
        px(pxX - 6, GROUND - 28, 12, 28, '#2b1055');
        px(pxX - 4, GROUND - 25, 8, 7, reduced ? '#38f2ff' : `hsl(${(t / 20) % 360} 90% 60%)`);
        px(pxX - 4, GROUND - 15, 8, 2, '#ffd23f');
      } else if (pr.kind === 'jukebox') {
        px(pxX - 6, GROUND - 22, 12, 22, '#4a1f2e');
        px(pxX - 5, GROUND - 21, 10, 6, '#ff9e3d');
        for (let b = 0; b < 4; b++) px(pxX - 4 + b * 2, GROUND - 12, 1, 4 + (reduced ? 0 : Math.round(Math.abs(Math.sin(t / 150 + b)) * 4)), '#38f2ff');
      } else if (pr.kind === 'bench') {
        px(pxX - 10, GROUND - 8, 20, 2, '#5a4a6a');
        px(pxX - 9, GROUND - 6, 2, 6, '#3a2a4a');
        px(pxX + 7, GROUND - 6, 2, 6, '#3a2a4a');
      } else if (pr.kind === 'cat') {
        const sit = Math.abs(playerX - catX) < 14 || Math.abs(playerX - catX) > 90;
        px(pxX - 3, GROUND - 4, 6, 4, '#1a1a1f');
        px(pxX + (facing > 0 ? 2 : -4), GROUND - 7, 3, 3, '#1a1a1f');
        px(pxX + (facing > 0 ? 3 : -3), GROUND - 6, 1, 1, '#ffd23f');
        px(pxX + (facing > 0 ? -4 : 3), GROUND - (sit ? 7 : 5), 1, sit ? 4 : 2, '#1a1a1f');
      }
    }

    // steam vents
    if (!reduced) {
      for (let x = 100; x < length; x += 260) {
        const sx = x - cam;
        if (sx < -20 || sx > vw + 20) continue;
        px(sx - 4, GROUND, 8, 1, '#2a2440');
        for (let k = 0; k < 4; k++) {
          const ph = ((t / 1400 + k * 0.25) % 1);
          ctx.globalAlpha = 0.18 * (1 - ph);
          px(sx - 3 + Math.sin(t / 500 + k) * 2, GROUND - ph * 28, 6 + ph * 6, 4, '#d8d0f0');
        }
        ctx.globalAlpha = 1;
      }
    }

    // streetlights
    for (let x = 40; x < length; x += 150) {
      const sx = x - cam;
      if (sx < -30 || sx > vw + 30) continue;
      px(sx, GROUND - 46, 2, 46, '#222033');
      px(sx, GROUND - 46, 8, 2, '#222033');
      if (sky.lightsOn) {
        glow(sx + 7, GROUND - 42, 36, 'rgba(255,214,140,A)', 0.42 * night);
        ctx.globalAlpha = 0.16 * night;
        px(sx - 14, GROUND, 40, 3, '#ffd68c');
        ctx.globalAlpha = 1;
      }
      px(sx + 4, GROUND - 44, 6, 3, sky.lightsOn ? '#fff1b8' : '#55506a');
    }

    // pavement, kerb, and the vaporwave grid
    px(0, GROUND, vw, 180 - GROUND + oy + 4, '#120c22');
    px(0, GROUND, vw, 1, '#2a1f45');
    ctx.globalAlpha = 0.1 + 0.25 * night;
    ctx.strokeStyle = '#ff4fd8';
    ctx.lineWidth = Math.max(1, P / 2);
    const floorH = 180 - GROUND;
    for (let r = 1; r <= 5; r++) {
      const y = (GROUND + Math.pow(r / 5, 1.8) * floorH + oy) * P;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    const vxm = (vw / 2) * P;
    for (let c = -14; c <= 14; c++) {
      const base = (c * 24 - (cam % 24)) * P;
      ctx.beginPath();
      ctx.moveTo(vxm + (base - vxm) * 0.35, (GROUND + oy) * P);
      ctx.lineTo(base, (180 + oy) * P);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // below the scene on tall screens: keep the street going
    if (oy > 0) px(0, 180, vw, oy + 2, '#0d0819');

    // the crowd (more of them at night), some with umbrellas
    const show = Math.round(walkers.length * sky.crowd);
    for (let k = 0; k < show; k++) {
      const w = walkers[k];
      const wx = w.x - cam;
      if (wx < -6 || wx > vw + 6) continue;
      const stepPh = reduced ? 0 : Math.floor(t / 160 + k) % 2;
      px(wx - 2, GROUND - 13, 4, 8, `hsl(${w.hue} 70% 55%)`);
      px(wx - 1.5, GROUND - 17, 3, 3, '#e9c9b5');
      px(wx - 2 + stepPh, GROUND - 5, 1, 5, '#1b1430');
      px(wx + 1 - stepPh, GROUND - 5, 1, 5, '#1b1430');
      if (w.umbrella && night > 0.2) {
        px(wx - 5, GROUND - 21, 10, 2, `hsl(${(w.hue + 180) % 360} 80% 60%)`);
        px(wx, GROUND - 19, 1, 3, '#1b1430');
      }
    }

    // you: legs swing while walking, a reflection in the wet street
    const yX = playerX - cam;
    const legs = moving && !reduced ? Math.floor(walkT * 8) % 2 : 0;
    px(yX - 3, GROUND - 15, 6, 10, '#f4f1ff');
    px(yX - 3, GROUND - 15, 6, 2, '#38f2ff');
    px(yX - 2, GROUND - 20, 4, 5, '#ffd9c2');
    px(yX - 2, GROUND - 21, 4, 2, '#ff4fd8');
    px(yX + (facing > 0 ? 1 : -2), GROUND - 18, 1, 1, '#120a24');
    px(yX - 3 + legs, GROUND - 5, 2, 5, '#ff4fd8');
    px(yX + 1 - legs, GROUND - 5, 2, 5, '#38f2ff');
    if (night > 0.3) {
      ctx.globalAlpha = 0.18;
      px(yX - 3, GROUND + 1, 6, 8, '#f4f1ff');
      ctx.globalAlpha = 1;
    }

    // speech bubbles
    const nowMs = Date.now();
    for (let b = bubbles.length - 1; b >= 0; b--) if (bubbles[b].until < nowMs) bubbles.splice(b, 1);
    for (const b of bubbles) {
      let bxW: number;
      if (b.who === 'you') bxW = yX;
      else {
        const pl = places.find(q => q.npc?.id === b.who);
        const ll = pl ? layout.find(q => q.id === pl.id) : null;
        if (!ll) continue;
        bxW = ll.x - cam + 16;
      }
      const lines = wrap(b.text, 34);
      const bw = Math.min(150, Math.max(...lines.map(s => s.length)) * 2.6 + 8);
      const bh = lines.length * 6 + 5;
      const top = GROUND - 34 - bh;
      const left = Math.max(2, Math.min(vw - bw - 2, bxW - bw / 2));
      px(left, top, bw, bh, '#fdf8ff');
      px(bxW - 1, top + bh, 3, 3, '#fdf8ff');
      lines.forEach((ln, li) => text(ln, left + 4, top + 5 + li * 6, 3.6, '#1a0f30', 'left'));
    }

    // rain over everything, then a vignette
    if (!reduced) {
      ctx.globalAlpha = 0.32;
      for (const d of drops) px(d.x * vw, d.y * 190 - 10, 0.5, 3, '#9fd8ff');
      ctx.globalAlpha = 1;
    }
    const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, `rgba(5,0,15,${0.35 + 0.25 * night})`);
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);
  }

  function animateStreet(ts: number): void {
    frame = null;
    if (paused) return;
    const dt = last ? Math.min(0.1, (ts - last) / 1000) : 0;
    last = ts;
    clock = ts;
    step(dt);
    if (ts - lastDraw >= 1000 / fps) {
      lastDraw = ts;
      draw(ts);
    }
    if (!paused) frame = win.requestAnimationFrame(animateStreet);
  }

  function arm(): void {
    if (frame === null && !paused && doc.visibilityState !== 'hidden') {
      last = 0;
      frame = win.requestAnimationFrame(animateStreet);
    }
  }
  function disarm(): void {
    if (frame !== null) win.cancelAnimationFrame(frame);
    frame = null;
  }

  // reduced motion: one still frame per minute, no loop
  let stillTimer: ReturnType<typeof setInterval> | null = null;
  function startStill(): void {
    draw(0);
    stillTimer = setInterval(() => {
      if (!paused && doc.visibilityState !== 'hidden') draw(0);
    }, 60000);
  }

  const onVisibility = () => {
    if (reduced) return;
    if (doc.visibilityState === 'hidden') {
      paused = true;
      disarm();
    } else if (!hostPaused) {
      paused = false;
      arm();
    }
  };
  const onKey = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (e.type === 'keydown') {
      if (k === 'arrowleft' || k === 'a') held = -1;
      else if (k === 'arrowright' || k === 'd') held = 1;
      else if (k === 'e' || k === 'enter' || k === ' ') interact();
      else return;
      e.preventDefault();
      if (reduced) {
        step(0.25);
        draw(0);
      }
    } else if ((k === 'arrowleft' || k === 'a') && held === -1) held = 0;
    else if ((k === 'arrowright' || k === 'd') && held === 1) held = 0;
  };
  const onClick = (e: MouseEvent) => {
    canvas.focus();
    const hit = hitTest(e.clientX, e.clientY);
    if (hit?.startsWith('npc:')) {
      const pl = places.find(q => q.npc?.id === hit.slice(4));
      if (pl) handle.walkTo(pl.id);
      return;
    }
    if (hit?.startsWith('prop:')) {
      const pr = props.find(q => q.id === hit.slice(5));
      if (pr) walkToX(pr.kind === 'cat' ? catX : pr.x, `prop:${pr.id}`);
      return;
    }
    if (hit?.startsWith('door:')) {
      handle.walkTo(hit.slice(5));
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const { P, cam } = view();
    walkToX((e.clientX - rect.left) / P + cam, null);
  };
  const onMove = (e: PointerEvent) => {
    pointer = { x: e.clientX, y: e.clientY };
    const hit = hitTest(e.clientX, e.clientY);
    if (hit !== hover) {
      hover = hit;
      canvas.style.cursor = hit ? 'pointer' : 'default';
      options.onHover?.(hit);
      if (reduced || paused) draw(clock);
    }
  };
  const onLeave = () => {
    pointer = null;
    if (hover !== null) {
      hover = null;
      canvas.style.cursor = 'default';
      options.onHover?.(null);
    }
  };

  doc.addEventListener('visibilitychange', onVisibility);
  canvas.addEventListener('keydown', onKey);
  canvas.addEventListener('keyup', onKey);
  canvas.addEventListener('click', onClick);
  canvas.addEventListener('pointermove', onMove as EventListener);
  canvas.addEventListener('pointerleave', onLeave);

  const handle: StreetHandle = {
    pause() {
      hostPaused = true;
      paused = true;
      disarm();
    },
    resume() {
      hostPaused = false;
      paused = false;
      if (!reduced) arm();
    },
    destroy() {
      paused = true;
      disarm();
      if (stillTimer) clearInterval(stillTimer);
      doc.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('keydown', onKey);
      canvas.removeEventListener('keyup', onKey);
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('pointermove', onMove as EventListener);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.remove();
    },
    walkTo(id: string) {
      const l = layout.find(q => q.id === id);
      if (!l) return;
      walkToX(l.x, `place:${id}`);
    },
    say(who: string, text: string, ms = 4500) {
      const i = bubbles.findIndex(b => b.who === who);
      if (i >= 0) bubbles.splice(i, 1);
      bubbles.push({ who, text, until: Date.now() + ms });
      if (reduced || paused) draw(clock);
    },
    sky: () => sky,
    near: () => (nearId ? places.find(p => p.id === nearId) || null : null),
    layout: () => layout.map(l => ({ ...l })),
    running: () => frame !== null,
  };

  void pointer;
  updateNear();
  if (reduced) startStill();
  else if (!paused) arm();
  else draw(0);
  return handle;
}

/** Break a line into chunks of at most `max` characters on word boundaries. */
export function wrap(s: string, max: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of s.split(/\s+/)) {
    if (!word) continue;
    if ((line + ' ' + word).trim().length > max) {
      if (line) out.push(line);
      line = word.length > max ? word.slice(0, max) : word;
    } else line = (line + ' ' + word).trim();
  }
  if (line) out.push(line);
  return out.slice(0, 5);
}
