/**
 * A LARGE field settles off-screen and then stays still (2026-11-07 phone lag).
 *
 * The blog journey (337 bodies) animated its settle: every tick rewrote ~3,000 SVG
 * attributes, so the ~300 ticks ran at 4 fps on a throttled phone and the page lagged
 * for over a minute. heat() now settles a field of SYNC_SETTLE_NODES or more
 * synchronously and paints once; a links-only update and a resize keep the layout.
 *
 * rAF is real here (16 ms timers), so an engine that still ANIMATES its settle moves
 * bodies between the two reads and this test fails.
 *
 *   npx esbuild test/settle.ts --bundle --platform=node --format=esm --outfile=test/settle.mjs --external:jsdom
 *   node test/settle.mjs
 */
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="stage"></div></body></html>', {
  pretendToBeVisual: true,
});
const { window } = dom;
const container = window.document.querySelector('#stage') as HTMLElement;
container.getBoundingClientRect = () =>
  ({ width: 1280, height: 800, top: 0, left: 0, right: 1280, bottom: 800, x: 0, y: 0 }) as DOMRect;

const globalAny = globalThis as Record<string, unknown>;
globalAny.window = window;
globalAny.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true });
const raf = (cb: FrameRequestCallback): number =>
  setTimeout(() => cb(performance.now()), 16) as unknown as number;
const caf = (id: number): void => clearTimeout(id);
(window as unknown as Record<string, unknown>).requestAnimationFrame = raf;
(window as unknown as Record<string, unknown>).cancelAnimationFrame = caf;
globalAny.requestAnimationFrame = raf;
globalAny.cancelAnimationFrame = caf;
for (const name of ['Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'SVGSVGElement', 'DOMRect'] as const) {
  globalAny[name] = (window as unknown as Record<string, unknown>)[name];
}

const { createBeadSpace } = await import('../src/core/bead-space');

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const N = 300;
const nodes = Array.from({ length: N }, (_, i) => ({
  id: `n${i}`,
  title: `Body ${i}`,
  cluster: `c${i % 12}`,
  status: 'open' as const,
}));
const links = Array.from({ length: 420 }, (_, i) => ({
  source: `n${i % N}`,
  target: `n${(i * 7 + 3) % N}`,
  kind: 'related' as const,
})).filter((l) => l.source !== l.target);

function positions(): string[] {
  return [...container.querySelectorAll('g.bs-node')].map((g) => g.getAttribute('transform') ?? '');
}

console.log('large-field settle');
const handle = createBeadSpace(container, { nodes, links }, { labelCollision: true, tooltips: false });
const first = positions();
check('every body is drawn', first.length === N, `${first.length}`);
check(
  'bodies are laid out at once (not at the origin)',
  new Set(first).size > N * 0.9,
  `${new Set(first).size} distinct of ${N}`,
);

await sleep(400);
const later = positions();
const moved = later.filter((p, i) => p !== first[i]).length;
check('the field stays still after the first paint', moved === 0, `${moved} bodies moved in 400 ms`);

// A host highlighting a path swaps only links: no body moves, the new link is drawn.
const pathLinks = [
  { source: 'n1', target: 'n2', kind: 'parent-child' as const },
  { source: 'n2', target: 'n3', kind: 'parent-child' as const },
];
handle.update({ nodes, links: pathLinks });
await sleep(300);
const afterLinks = positions();
const movedOnLinks = afterLinks.filter((p, i) => p !== first[i]).length;
check('a links-only update moves no body', movedOnLinks === 0, `${movedOnLinks} moved`);
const drawn = [...container.querySelectorAll('line.bs-link, path.bs-link, .bs-link')].length;
check('the new path links are drawn', drawn >= pathLinks.length, `${drawn}`);

handle.destroy();
console.log(failures ? `${failures} FAILURE(S)` : 'settle: all checks passed');
process.exit(failures ? 1 : 0);
