/**
 * Semantic-zoom contract (2026-10-22): a host that drives levels (universe -> galaxy ->
 * system) pins bodies where the level puts them, sizes and tints them by meaning, never
 * shows two overlapping labels, gets right-click as a verb menu, and can show activity as
 * pulses / packets / a probe. Self-contained (jsdom, no fixtures).
 *
 *   npx esbuild test/semantic-zoom.ts --bundle --platform=node --format=esm --outfile=test/semantic-zoom.mjs --external:jsdom
 *   node test/semantic-zoom.mjs
 */
import { JSDOM } from 'jsdom';
import { cullLabels } from '../src/core/labels';
import type { BeadData, BeadNode } from '../src/types';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('label culling (pure)');
{
  const shown = cullLabels(
    [
      { id: 'big', x: 0, y: 0, w: 100, h: 14, priority: 10 },
      { id: 'small-overlaps', x: 50, y: 5, w: 80, h: 14, priority: 1 },
      { id: 'clear', x: 300, y: 0, w: 60, h: 14, priority: 1 },
      { id: 'offscreen', x: 5000, y: 0, w: 60, h: 14, priority: 99 },
    ],
    { width: 800, height: 600 },
  );
  check('the bigger body keeps its label', shown.has('big'));
  check('an overlapping smaller label is hidden', !shown.has('small-overlaps'));
  check('a clear label is shown', shown.has('clear'));
  check('an off-screen label takes no room', !shown.has('offscreen'));
}

const dom = new JSDOM('<!doctype html><html><body><div id="stage"></div></body></html>', {
  pretendToBeVisual: true,
});
const { window } = dom;
const container = window.document.querySelector('#stage') as HTMLElement;
container.getBoundingClientRect = () =>
  ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 }) as DOMRect;
const g = globalThis as Record<string, unknown>;
g.window = window;
g.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true });
// jsdom has no layout: give SVG elements the bits d3-zoom/transition read.
(window as unknown as Record<string, unknown>).matchMedia = () => ({ matches: true, addListener() {}, removeListener() {} });

const { createBeadSpace } = await import('../src/core/bead-space');

const node = (id: string, extra: Partial<BeadNode> = {}): BeadNode => ({
  id,
  title: id,
  cluster: 'c',
  status: 'open',
  assignee: null,
  createdAt: '2026-10-22T00:00:00Z',
  stateStartedAt: null,
  ...extra,
});
const PINS: Record<string, [number, number]> = { core: [0, 0], a: [200, 0], b: [-200, 0] };
const data: BeadData = {
  nodes: [node('core'), node('a', { status: 'in_progress' }), node('b', { status: 'deferred' })],
  links: [
    { source: 'core', target: 'a', kind: 'parent-child' },
    { source: 'core', target: 'b', kind: 'parent-child' },
  ],
};
const menus: string[] = [];

console.log('engine options');
const handle = createBeadSpace(container, data, {
  reducedMotion: true,
  fixedPosition: (n) => PINS[n.id] ?? null,
  nodeRadius: (n) => (n.id === 'core' ? 40 : 12),
  nodeColor: (n) => (n.id === 'a' ? '#5EC9CC' : null),
  nodeClass: (n) => (n.status === 'deferred' ? 'bs-cold' : n.status === 'in_progress' ? 'bs-busy' : null),
  labelCollision: true,
  parallax: true,
  onContextMenu: (n) => menus.push(n.id),
});

const pos = handle.screenPosition('a');
const core = handle.screenPosition('core');
check('pinned bodies sit where the host put them', !!pos && !!core && Math.abs(pos.y - core.y) < 0.01 && pos.x > core.x,
  JSON.stringify({ pos, core }));
const groups = [...container.querySelectorAll('g.bs-node')] as SVGGElement[];
const byId = (id: string) => groups.find((el) => el.getAttribute('aria-label')?.startsWith(`${id}:`));
check('nodeClass lands on the body', !!byId('b')?.classList.contains('bs-cold') && !!byId('a')?.classList.contains('bs-busy'));
check('nodeRadius drives the core radius', byId('core')?.querySelector('.bs-planet-core')?.getAttribute('r') === '40');
check('nodeColor is exposed as --bs-core-tint', (byId('a') as SVGGElement | undefined)?.style.getPropertyValue('--bs-core-tint') === '#5EC9CC');
check('parallax draws a far starfield', container.querySelectorAll('.bs-starfield-far circle').length > 0);

byId('a')!.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
check('right-click opens the verb menu for that body', menus.join() === 'a');

check('nodeNearCenter finds the body at the centre', handle.nodeNearCenter()?.id === 'core');

console.log('activity');
handle.pulse('a');
handle.packet('a', 'b');
check('a packet to an unknown body reports false so the host can aggregate', handle.packet('a', 'nope') === false);
handle.probe('b', { label: 'explorer' });
check('the probe is drawn', container.querySelectorAll('.bs-probe').length === 1);
handle.probe(null);
check('probe(null) removes it', container.querySelectorAll('.bs-probe').length === 0);

console.log('levels');
handle.update(
  { nodes: [node('galaxy'), node('s1'), node('s2')], links: [] },
  { enter: 'in' },
);
check('update with enter replaces the level', container.querySelectorAll('g.bs-node').length === 3);
await handle.flyTo('galaxy', { scale: 2 });
check('flyTo resolves', true);
await handle.zoomBy(0.5);
check('zoomBy resolves', true);

handle.destroy();
check('destroy removes all DOM', container.children.length === 0);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nPASS');
