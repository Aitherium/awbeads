/**
 * The street: BeadSpace's walkable scene mode (owner, 2026-10-17). A neon pixel-art
 * street you walk along; each place is a storefront bead; the agents stand at their
 * doors; the sky follows the visitor's real clock (`skyAt`). The universe/galaxy view
 * stays the map. This is a scene of the same engine, not a separate app.
 *
 * Cost rules (the owner games on the machine that serves this): ONE animation loop,
 * capped at `fps` (30 by default), never scheduled while paused or while the tab is
 * hidden, and a visible tab never resumes a street the HOST paused (same contract as
 * createBeadSpace, test/pause.ts).
 */

import { hash } from '../core/hash';
import { skyAt, type Sky, type SkyOptions } from './sky';

export type StreetPlaceKind = 'shop' | 'bar' | 'spaces' | 'arcade' | 'gate' | 'lot' | 'home' | 'space';

export interface StreetNpc {
  id: string;
  name: string;
  /** Persona colour, used for the sprite when no image is given. */
  color?: string;
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

export interface StreetOptions {
  places: StreetPlace[];
  /** The clock; inject for tests and screenshots. */
  now?: () => Date;
  sky?: SkyOptions;
  paused?: boolean;
  /** No rain, no walking crowd, no twinkle: one still frame per minute. */
  reducedMotion?: boolean;
  fps?: number;
  /** Seed for skyline and crowd so a street looks the same on every visit. */
  seed?: string;
  onEnter?: (place: StreetPlace) => void;
  onTalk?: (npc: StreetNpc, place: StreetPlace) => void;
  /** Called when the place you stand at changes (null = between doors). */
  onNear?: (place: StreetPlace | null) => void;
}

export interface StreetHandle {
  pause(): void;
  resume(): void;
  destroy(): void;
  /** Walk to a place's door. */
  walkTo(id: string): void;
  /** The sky being drawn now. */
  sky(): Sky;
  /** The place you stand at, or null. */
  near(): StreetPlace | null;
  /** Door x positions in street units (for tests and the map). */
  layout(): { id: string; x: number; width: number }[];
  /** True while an animation frame is scheduled. */
  running(): boolean;
}

export const BLOCK_W = 96; // street units per storefront
const GAP_W = 24; // alley between storefronts
const EDGE_W = 64; // street before the first and after the last door
const DOOR_REACH = 30; // how close counts as "at the door"
const WALK_SPEED = 70; // street units per second

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

  const canvas = doc.createElement('canvas');
  canvas.className = 'bead-street';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `A street with ${places.map(p => p.sign).join(', ')}`);
  canvas.tabIndex = 0;
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.imageRendering = 'pixelated';
  container.appendChild(canvas);
  const ctx = (canvas.getContext && canvas.getContext('2d')) as CanvasRenderingContext2D | null;

  let playerX = layout.length ? layout[0].x : EDGE_W;
  let target: number | null = null;
  let arriveAt: string | null = null;
  let held = 0; // -1 left, +1 right from the keyboard
  let nearId: string | null = null;
  let paused = !!options.paused;
  let hostPaused = paused;
  let frame: number | null = null;
  let last = 0;
  let lastDraw = 0;
  let sky = skyAt(now(), options.sky);
  const drops = Array.from({ length: 70 }, (_, i) => ({ x: rnd(seed, i * 3), y: rnd(seed, i * 3 + 1), v: 0.6 + rnd(seed, i * 3 + 2) }));
  const walkers = Array.from({ length: 14 }, (_, i) => ({
    x: rnd(seed, 500 + i) * length,
    dir: rnd(seed, 600 + i) > 0.5 ? 1 : -1,
    speed: 12 + rnd(seed, 700 + i) * 18,
    hue: Math.floor(rnd(seed, 800 + i) * 360),
  }));

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

  function interact(): void {
    const p = placeAt(playerX);
    if (!p) return;
    if (p.npc && options.onTalk) options.onTalk(p.npc, p);
    else if (!p.closed) options.onEnter?.(p);
  }

  function step(dt: number): void {
    const dir = held !== 0 ? held : target === null ? 0 : Math.sign(target - playerX);
    if (held !== 0) target = null;
    if (dir !== 0) {
      let nx = playerX + dir * WALK_SPEED * dt;
      if (target !== null && Math.sign(target - nx) !== dir) {
        nx = target;
        target = null;
        if (arriveAt) {
          const p = places.find(q => q.id === arriveAt);
          arriveAt = null;
          if (p) {
            playerX = nx;
            updateNear();
            if (p.npc && options.onTalk) options.onTalk(p.npc, p);
            else if (!p.closed) options.onEnter?.(p);
          }
        }
      }
      playerX = Math.min(length - 8, Math.max(8, nx));
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
    }
    updateNear();
  }

  // ---- drawing (every unit is snapped to the pixel scale P) ----
  function draw(t: number): void {
    sky = skyAt(now(), options.sky);
    if (!ctx) return;
    const rect = container.getBoundingClientRect();
    const W = Math.max(1, Math.floor(rect.width));
    const H = Math.max(1, Math.floor(rect.height));
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    const P = Math.max(2, Math.floor(H / 180)); // pixel scale: ~180 art pixels tall
    const vw = W / P; // view width in art pixels
    const ground = 150; // street line, art pixels from the top
    const cam = Math.min(Math.max(0, playerX - vw / 2), Math.max(0, length - vw));
    ctx.imageSmoothingEnabled = false;
    const px = (x: number, y: number, w: number, h: number, c: string) => {
      ctx.fillStyle = c;
      ctx.fillRect(Math.round(x) * P, Math.round(y) * P, Math.max(1, Math.round(w)) * P, Math.max(1, Math.round(h)) * P);
    };

    // sky
    const g = ctx.createLinearGradient(0, 0, 0, ground * P);
    g.addColorStop(0, sky.top);
    g.addColorStop(1, sky.horizon);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    if (sky.starAlpha > 0) {
      ctx.globalAlpha = sky.starAlpha;
      for (let i = 0; i < 60; i++) {
        const tw = reduced ? 1 : 0.6 + 0.4 * Math.sin(t / 700 + i);
        ctx.globalAlpha = sky.starAlpha * tw;
        px(rnd(seed, 9000 + i) * vw, rnd(seed, 9100 + i) * 90, 1, 1, '#ffffff');
      }
      ctx.globalAlpha = 1;
    }
    const bx = sky.bodyX * vw;
    const by = 110 - sky.bodyY * 90;
    if (sky.body === 'moon') {
      ctx.shadowColor = '#cdb8ff';
      ctx.shadowBlur = 18 * P;
      ctx.fillStyle = '#f4f1ff';
      ctx.beginPath();
      ctx.arc(bx * P, by * P, 7 * P, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = sky.top; // crescent bite
      ctx.beginPath();
      ctx.arc((bx + 3.5) * P, (by - 2) * P, 6.5 * P, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // the vaporwave sun: a disc with horizontal bands, warmer as it sinks
      const r = 14;
      const sg = ctx.createLinearGradient(0, (by - r) * P, 0, (by + r) * P);
      sg.addColorStop(0, '#fff3a8');
      sg.addColorStop(1, sky.phase === 'day' ? '#ffd27a' : '#ff4fa0');
      ctx.fillStyle = sg;
      ctx.shadowColor = '#ffb0d8';
      ctx.shadowBlur = 24 * P;
      ctx.beginPath();
      ctx.arc(bx * P, by * P, r * P, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      if (sky.phase !== 'day') {
        ctx.fillStyle = sky.horizon;
        for (let b = 0; b < 4; b++) ctx.fillRect((bx - r) * P, (by + 2 + b * 3) * P, 2 * r * P, (1 + b * 0.5) * P);
      }
    }
    // a few slow clouds by day
    if (sky.daylight > 0.3) {
      ctx.globalAlpha = 0.5 * sky.daylight;
      for (let c = 0; c < 5; c++) {
        const cx = ((rnd(seed, 7000 + c) * vw * 2 + (reduced ? 0 : t / 400) * (0.5 + c * 0.1)) % (vw + 60)) - 30;
        const cy = 20 + rnd(seed, 7100 + c) * 50;
        px(cx, cy, 26, 4, '#ffffff');
        px(cx + 6, cy - 3, 14, 3, '#ffffff');
      }
      ctx.globalAlpha = 1;
    }

    // far skyline, slow parallax
    const far = cam * 0.25;
    for (let i = 0; i < 40; i++) {
      const w = 14 + rnd(seed, 100 + i) * 22;
      const h = 30 + rnd(seed, 200 + i) * 70;
      const x = i * 26 - (far % (40 * 26));
      const xx = ((x % (40 * 26)) + 40 * 26) % (40 * 26) - 26;
      if (xx > vw) continue;
      px(xx, ground - 20 - h, w, h + 20, sky.daylight > 0.5 ? '#5a6b8f' : '#1a1036');
      if (sky.glow > 0.3) {
        for (let k = 0; k < 6; k++) {
          if (rnd(seed, 300 + i * 7 + k) < 0.45) {
            ctx.globalAlpha = sky.glow;
            px(xx + 3 + (k % 2) * 6, ground - 14 - h + Math.floor(k / 2) * 10, 2, 3, '#ffd66b');
            ctx.globalAlpha = 1;
          }
        }
      }
    }

    // storefronts
    layout.forEach((l, i) => {
      const p = places[i];
      const color = p.color || KIND_COLOR[p.kind || 'shop'];
      const x = l.x - BLOCK_W / 2 - cam;
      if (x > vw || x + BLOCK_W < 0) return;
      const h = 70 + (hash(`${seed}:${p.id}`) % 25);
      px(x, ground - h, BLOCK_W, h, sky.daylight > 0.5 ? '#3a3f5c' : '#160d2b');
      px(x + 8, ground - 30, BLOCK_W - 16, 30, p.closed ? '#2b2b33' : '#0e0a18'); // shopfront
      // door
      px(l.x - cam - 7, ground - 24, 14, 24, p.closed ? '#444' : color);
      // neon sign
      const lit = !p.closed;
      const flick = reduced ? 1 : 0.85 + 0.15 * Math.sin(t / 90 + i * 3);
      ctx.globalAlpha = lit ? Math.max(0.55, sky.glow) * flick : 0.35;
      if (lit && sky.glow > 0.3) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 16 * P * sky.glow;
      }
      px(x + 10, ground - h + 8, BLOCK_W - 20, 14, color);
      ctx.shadowBlur = 0;
      // the sign's reflection in the wet street
      if (lit && sky.glow > 0.3) {
        ctx.globalAlpha = 0.22 * sky.glow * flick;
        px(x + 14, ground + 3, BLOCK_W - 28, 2, color);
        px(x + 22, ground + 8, BLOCK_W - 44, 1, color);
        px(x + 30, ground + 12, BLOCK_W - 60, 1, color);
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#0b0420';
      ctx.font = `bold ${Math.max(8, 7 * P)}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.sign.toUpperCase().slice(0, 12), (l.x - cam) * P, (ground - h + 15) * P);
      // upstairs windows
      for (let k = 0; k < 8; k++) {
        const on = rnd(seed, 4000 + i * 13 + k) < 0.3 + 0.6 * sky.glow;
        px(x + 12 + (k % 4) * 20, ground - h + 30 + Math.floor(k / 4) * 14, 8, 8, on ? '#ffcf6b' : '#241a3d');
      }
      // the agent at the door
      if (p.npc) {
        const nx = l.x - cam + 12;
        px(nx - 3, ground - 16, 6, 10, p.npc.color || '#ffffff');
        px(nx - 2, ground - 21, 4, 4, '#ffd9c2');
        ctx.fillStyle = '#ffffff';
        ctx.font = `${Math.max(7, 4 * P)}px monospace`;
        ctx.fillText(p.npc.name, nx * P, (ground - 26) * P);
      }
    });

    // streetlights
    for (let x = 40; x < length; x += 140) {
      const sx = x - cam;
      if (sx < -20 || sx > vw + 20) continue;
      px(sx, ground - 40, 2, 40, '#222033');
      if (sky.lightsOn) {
        const lx = (sx + 1) * P;
        const ly = (ground - 38) * P;
        const halo = ctx.createRadialGradient(lx, ly, 0, lx, ly, 34 * P);
        halo.addColorStop(0, `rgba(255,214,140,${0.45 * sky.glow})`);
        halo.addColorStop(1, 'rgba(255,214,140,0)');
        ctx.fillStyle = halo;
        ctx.fillRect(lx - 34 * P, ly - 34 * P, 68 * P, 72 * P);
        // the pool of light on the pavement
        ctx.globalAlpha = 0.18 * sky.glow;
        px(sx - 16, ground, 34, 3, '#ffd68c');
        ctx.globalAlpha = 1;
      }
      px(sx - 2, ground - 42, 6, 3, sky.lightsOn ? '#fff1b8' : '#55506a');
    }

    // pavement and puddle reflections
    px(0, ground, vw, 180 - ground, '#120c22');
    // vaporwave floor grid: receding rows, verticals that scroll with you
    ctx.globalAlpha = 0.12 + 0.25 * sky.glow;
    ctx.strokeStyle = '#ff4fd8';
    ctx.lineWidth = Math.max(1, P / 2);
    for (let r = 1; r <= 5; r++) {
      const y = (ground + Math.pow(r / 5, 1.8) * (180 - ground)) * P;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    const vx = (vw / 2) * P;
    for (let c = -12; c <= 12; c++) {
      const base = (c * 24 - (cam % 24)) * P;
      ctx.beginPath();
      ctx.moveTo(vx + (base - vx) * 0.35, ground * P);
      ctx.lineTo(base, 180 * P);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // the crowd (more of them at night)
    const show = Math.round(walkers.length * sky.crowd);
    for (let k = 0; k < show; k++) {
      const w = walkers[k];
      const wx = w.x - cam;
      if (wx < -4 || wx > vw + 4) continue;
      const bob = reduced ? 0 : Math.round(Math.sin(t / 120 + k) * 0.6);
      px(wx - 2, ground - 12 + bob, 4, 8, `hsl(${w.hue} 80% 60%)`);
      px(wx - 1.5, ground - 16 + bob, 3, 3, '#e9c9b5');
    }

    // you
    const pxX = playerX - cam;
    px(pxX - 3, ground - 14, 6, 10, '#ffffff');
    px(pxX - 2, ground - 19, 4, 4, '#ffd9c2');
    px(pxX - 3, ground - 4, 2, 4, '#ff4fd8');
    px(pxX + 1, ground - 4, 2, 4, '#38f2ff');

    // rain
    if (!reduced) {
      ctx.globalAlpha = 0.35;
      for (const d of drops) px(d.x * vw, d.y * 180, 0.5, 3, '#9fd8ff');
      ctx.globalAlpha = 1;
    }
  }

  function animateStreet(ts: number): void {
    frame = null;
    if (paused) return;
    const dt = last ? Math.min(0.1, (ts - last) / 1000) : 0;
    last = ts;
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
    const rect = canvas.getBoundingClientRect();
    const P = Math.max(2, Math.floor(rect.height / 180));
    const vw = rect.width / P;
    const cam = Math.min(Math.max(0, playerX - vw / 2), Math.max(0, length - vw));
    const x = (e.clientX - rect.left) / P + cam;
    const hit = layout.find(l => Math.abs(l.x - x) <= BLOCK_W / 2);
    if (hit) handle.walkTo(hit.id);
    else target = x;
  };

  doc.addEventListener('visibilitychange', onVisibility);
  canvas.addEventListener('keydown', onKey);
  canvas.addEventListener('keyup', onKey);
  canvas.addEventListener('click', onClick);

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
      canvas.remove();
    },
    walkTo(id: string) {
      const l = layout.find(q => q.id === id);
      if (!l) return;
      target = l.x;
      arriveAt = id;
      if (reduced) {
        playerX = l.x;
        target = null;
        arriveAt = null;
        updateNear();
        draw(0);
      }
    },
    sky: () => sky,
    near: () => (nearId ? places.find(p => p.id === nearId) || null : null),
    layout: () => layout.map(l => ({ ...l })),
    running: () => frame !== null,
  };

  updateNear();
  if (reduced) startStill();
  else if (!paused) arm();
  else draw(0);
  return handle;
}
