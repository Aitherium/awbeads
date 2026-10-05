/**
 * Pause contract: a universe created paused schedules no animation frame and keeps its
 * simulation stopped; resuming re-arms the loop; a hidden tab pauses it on its own and a
 * visible tab never resumes a universe the HOST paused.
 *
 * Self-contained (no generated fixtures), so it runs on a fresh clone.
 */
import { JSDOM } from 'jsdom';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const dom = new JSDOM('<!doctype html><html><body><div id="stage"></div></body></html>', {
  pretendToBeVisual: true,
});
const { window } = dom;
const container = window.document.querySelector('#stage') as HTMLElement;
container.getBoundingClientRect = () =>
  ({ width: 1280, height: 800, top: 0, left: 0, right: 1280, bottom: 800, x: 0, y: 0 }) as DOMRect;

let visibility: 'visible' | 'hidden' = 'visible';
Object.defineProperty(window.document, 'visibilityState', { get: () => visibility, configurable: true });

const globalAny = globalThis as Record<string, unknown>;
globalAny.window = window;
globalAny.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true });

// Count the SHIP LOOP's scheduled frames (d3-timer and zoom also use rAF; they are not
// the loop under test); never run them — the test asserts scheduling, not drawing.
let scheduled = 0;
let pending = new Set<number>();
let nextId = 1;
const raf = (cb: FrameRequestCallback): number => {
  const id = nextId++;
  if (cb.name !== 'animateShips') return id;
  scheduled += 1;
  pending.add(id);
  return id;
};
const caf = (id: number): void => {
  pending.delete(id);
};
(window as unknown as Record<string, unknown>).requestAnimationFrame = raf;
(window as unknown as Record<string, unknown>).cancelAnimationFrame = caf;
globalAny.requestAnimationFrame = raf;
globalAny.cancelAnimationFrame = caf;
for (const name of ['Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'SVGSVGElement', 'DOMRect'] as const) {
  globalAny[name] = (window as unknown as Record<string, unknown>)[name];
}

const { createBeadSpace } = await import('../src/core/bead-space');

const data = {
  nodes: ['a', 'b', 'c', 'd'].map((id, i) => ({
    id,
    title: `node ${id}`,
    cluster: i % 2 ? 'x' : 'y',
    status: 'in_progress' as const,
    assignee: 'demi',
    createdAt: new Date(2026, 0, 1 + i).toISOString(),
  })),
  links: [{ source: 'a', target: 'b', kind: 'blocks' as const }],
};

console.log('pause');
const root = () => container.querySelector('.bead-space') as Element | null;

const handle = createBeadSpace(container, data, { assetRoot: '/assets', paused: true });
check('created paused: no live frame', pending.size === 0, `pending=${pending.size}`);
check('created paused: root has bs-paused', Boolean(root()?.classList.contains('bs-paused')));
const nodes = container.querySelectorAll('.bs-node');
const laidOut = [...nodes].some((n) => {
  const t = n.getAttribute('transform') || '';
  return /translate\(/.test(t) && !/NaN/.test(t);
});
check('created paused: first layout still painted once', laidOut, `${nodes.length} nodes`);

handle.setPaused(false);
check('resume: loop re-armed', pending.size === 1, `pending=${pending.size}`);
check('resume: bs-paused removed', !root()?.classList.contains('bs-paused'));

handle.setPaused(true);
check('host pause: frame cancelled', pending.size === 0, `pending=${pending.size}`);

// Hidden then visible while the host still holds the pause: must stay paused.
visibility = 'hidden';
window.document.dispatchEvent(new window.Event('visibilitychange'));
visibility = 'visible';
window.document.dispatchEvent(new window.Event('visibilitychange'));
check('visible tab never resumes a host-paused universe', pending.size === 0, `pending=${pending.size}`);

handle.setPaused(false);
const before = scheduled;
visibility = 'hidden';
window.document.dispatchEvent(new window.Event('visibilitychange'));
check('hidden tab pauses the loop', pending.size === 0 && Boolean(root()?.classList.contains('bs-paused')));
visibility = 'visible';
window.document.dispatchEvent(new window.Event('visibilitychange'));
check('visible tab resumes it', pending.size === 1 && scheduled > before);

handle.destroy();
pending = new Set();
visibility = 'hidden';
window.document.dispatchEvent(new window.Event('visibilitychange'));
visibility = 'visible';
window.document.dispatchEvent(new window.Event('visibilitychange'));
check('destroyed: visibility listener gone', pending.size === 0, `pending=${pending.size}`);

if (failures) {
  console.error(`\n${failures} pause check(s) failed`);
  window.close();
  process.exit(1);
}
console.log('\npause: all checks passed');
// d3 timers and the jsdom window keep the event loop alive; the checks are done.
window.close();
process.exit(0);
