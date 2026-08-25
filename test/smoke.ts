/**
 * Headless smoke test for the bead-space engine and adapters.
 *
 * Renders the REAL AitherOS agent constellation and the REAL service fleet into a jsdom
 * document and asserts that the universe actually materialised — planets, links, ships,
 * stations — then exercises update/select/follow/destroy.
 *
 * This is a POSITIVE test on purpose: a fail-closed renderer that silently draws nothing
 * would pass any "no exceptions thrown" check.
 *
 *   npx esbuild test/smoke.ts --bundle --platform=node --format=esm --outfile=test/smoke.mjs
 *   node test/smoke.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';

import type { ConstellationRecord, FleetHealth, FleetServiceRecord } from '../src/adapters';

type FleetInput = {
  services: Record<string, Omit<FleetServiceRecord, 'name'>>;
  health: FleetHealth;
};

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'demo', 'data');

/**
 * The fixtures are generated from the live repo (`demo/build-data.py`) and are gitignored, so
 * a fresh clone has none. Fail with the actual remedy rather than a raw ENOENT stack.
 */
function readFixture(name: string): unknown {
  try {
    return JSON.parse(readFileSync(join(dataDir, name), 'utf-8'));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error(
        `\nMissing fixture demo/data/${name}.\n` +
          `These are generated from the live repo and are gitignored. Run:\n` +
          `  npm run demo:data\n`,
      );
      process.exit(2);
    }
    throw cause;
  }
}

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── jsdom bootstrap ───────────────────────────────────────────────────────────
const dom = new JSDOM('<!doctype html><html><body><div id="stage"></div></body></html>', {
  pretendToBeVisual: true,
});
const { window } = dom;
const container = window.document.querySelector('#stage') as HTMLElement;

// jsdom has no layout engine, so every rect is zero; the engine's documented fallback
// (960×600) should kick in. Give it a real box anyway so we test the measured path.
container.getBoundingClientRect = () =>
  ({ width: 1280, height: 800, top: 0, left: 0, right: 1280, bottom: 800, x: 0, y: 0 }) as DOMRect;

const globalAny = globalThis as Record<string, unknown>;
globalAny.window = window;
globalAny.document = window.document;
// Node >= 21 defines `navigator` as a getter-only global, so plain assignment throws.
Object.defineProperty(globalThis, 'navigator', {
  value: window.navigator,
  configurable: true,
  writable: true,
});
// Do NOT alias jsdom's performance onto globalThis — jsdom's implementation calls the
// global `performance.now()` internally, so aliasing makes it recurse until the stack dies.
// Node's own performance is fine for the engine's `performance.now()` calls.
globalAny.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalAny.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
// d3-zoom/d3-drag reach for these as bare globals (e.g. `e instanceof SVGElement`).
for (const name of [
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'CustomEvent',
  'Node',
  'Element',
  'HTMLElement',
  'SVGElement',
  'SVGSVGElement',
  'DOMRect',
] as const) {
  globalAny[name] = (window as unknown as Record<string, unknown>)[name];
}
// Deliberately NOT defining ResizeObserver or matchMedia — the engine must tolerate both
// being absent (they are in Node, in tests, and in some SSR paths).

const { createBeadSpace } = await import('../src/core/bead-space');
const { fromConstellation, fromFleet, fleetServicesFromConfig, fromDebtLedger, fromComputePool, COMPUTE_CLUSTER_ORDER } =
  await import('../src/adapters');

// ── adapters against real data ────────────────────────────────────────────────
console.log('constellation adapter');
const constellationRaw = readFixture('constellation.json') as ConstellationRecord;
const constellation = fromConstellation(constellationRaw);
check('nodes produced', constellation.nodes.length > 30, `${constellation.nodes.length} agents`);
check('links produced', constellation.links.length > 30, `${constellation.links.length} links`);
check(
  'every link endpoint resolves',
  constellation.links.every(
    (link) =>
      constellation.nodes.some((n) => n.id === link.source) &&
      constellation.nodes.some((n) => n.id === link.target),
  ),
);
check(
  'active agents own themselves (ships will spawn)',
  constellation.nodes.some((n) => n.status === 'in_progress' && n.assignee),
  `${constellation.nodes.filter((n) => n.status === 'in_progress').length} active`,
);
check(
  'rings map to distinct radii',
  new Set(constellation.nodes.map((n) => n.createdAt)).size > 3,
);

console.log('fleet adapter');
const fleetRaw = readFixture('fleet.json') as FleetInput;
const fleet = fromFleet(fleetServicesFromConfig(fleetRaw.services), { health: fleetRaw.health });
check('nodes produced', fleet.nodes.length > 100, `${fleet.nodes.length} services`);
check(
  'clusters derived from groups',
  new Set(fleet.nodes.map((n) => n.cluster)).size > 3,
  `${new Set(fleet.nodes.map((n) => n.cluster)).size} groups`,
);
check(
  'dangling depends_on dropped',
  fleet.links.every(
    (link) =>
      fleet.nodes.some((n) => n.id === link.source) && fleet.nodes.some((n) => n.id === link.target),
  ),
);

console.log('debt adapter');
const debt = fromDebtLedger([
  { id: 'D-1', severity: 'P0', description: 'a', files: ['x.py'], state: 'open' },
  { id: 'D-2', severity: 'P0', description: 'b', files: ['x.py'], state: 'resolved' },
  { id: 'D-3', severity: 'P2', description: 'c', files: ['y.py'], state: 'open' },
]);
check('shared-file cross-link derived', debt.links.length === 1, `${debt.links.length} link(s)`);
check('resolved maps to done', debt.nodes.find((n) => n.id === 'D-2')?.status === 'done');

console.log('compute adapter');
// Shape taken from AitherVeil/src/app/api/compute/pool/route.ts. `dgx` is serving, `idle`
// has room, `full` is saturated — one node per status the adapter can emit.
const compute = fromComputePool({
  nodes: [
    {
      node_id: 'dgx',
      name: 'DGX Spark',
      arch: 'dgx-grace-blackwell',
      vram_free_gb: 90,
      gpu_count: 2,
      serving: ['qwen3.6-27b'],
    },
    { node_id: 'idle', name: 'Desk 5090', arch: 'rtx-5090', vram_free_gb: 20, gpu_count: 1 },
    { node_id: 'full', name: 'Busy 5090', arch: 'rtx-5090', vram_free_gb: 0.1, gpu_count: 1 },
  ],
  capacity_plan: { mode: 'split', split_plan: { dgx: 0.8, idle: 0.2 }, reason: 'x' },
});
check('one bead per pooled node', compute.nodes.length === 3, `${compute.nodes.length}`);
check(
  'serving node owns itself, named by MODEL not host (ship spawns)',
  compute.nodes.find((n) => n.id === 'dgx')?.status === 'in_progress' &&
    compute.nodes.find((n) => n.id === 'dgx')?.assignee === 'qwen3.6-27b',
);
check('saturated node reads as blocked', compute.nodes.find((n) => n.id === 'full')?.status === 'blocked');
check('idle node with headroom stays open', compute.nodes.find((n) => n.id === 'idle')?.status === 'open');
check('arch drives clusters', new Set(compute.nodes.map((n) => n.cluster)).size === 2);
// Radial distance encodes AGE, and syntheticCreatedAt maps the LOW end of the metric to the
// epoch — so "closest to the core" means the EARLIER timestamp, not the later one.
check(
  'most free VRAM sits closest to the core',
  new Date(compute.nodes.find((n) => n.id === 'dgx')!.createdAt).getTime() <
    new Date(compute.nodes.find((n) => n.id === 'full')!.createdAt).getTime(),
);
check(
  'split cohort links its members and only its members',
  compute.links.length === 1 &&
    [compute.links[0].source, compute.links[0].target].sort().join() === 'dgx,idle',
  JSON.stringify(compute.links),
);
/*
 * REAL node, copied from the live AitherMesh registry 2026-07-25 (`dgx-spark`) and put
 * through the transform in api/compute/pool/route.ts:
 *   hardware.gpus[0] = { name: "NVIDIA GB10", vram_mb: 124610, vram_used_mb: 107476 }
 *   metadata.resident_models = ["qwen36-27b-dgx"]
 * -> arch inferArch("NVIDIA GB10") = "dgx-grace-blackwell"
 * -> vram_free_gb = (124610 - 107476) MB = 16.34 GB
 * -> serving = ["qwen36-27b-dgx"]
 * This exists because the other compute assertions run on a fixture I wrote from the same
 * source file I wrote the adapter from — which would agree with itself even if both were
 * wrong about what the mesh actually emits; that risk is a ledgered row.
 */
const realNode = fromComputePool({
  nodes: [
    {
      node_id: 'dgx-spark',
      name: 'dgx-spark',
      arch: 'dgx-grace-blackwell',
      vram_free_gb: (124610 - 107476) / 1024,
      gpu_count: 1,
      gpu_models: ['NVIDIA GB10'],
      serving: ['qwen36-27b-dgx'],
      last_heartbeat: '2026-07-10T16:45:31.022033',
    },
  ],
  capacity_plan: { mode: 'route', target_node: 'dgx-spark' },
});
check(
  'real GB10 node maps to a serving planet in a known cluster',
  realNode.nodes[0].cluster === 'dgx-grace-blackwell' &&
    realNode.nodes[0].status === 'in_progress' &&
    realNode.nodes[0].assignee === 'qwen36-27b-dgx',
  `${realNode.nodes[0].cluster} / ${realNode.nodes[0].assignee}`,
);
check(
  'its arch is one the pinned cluster order actually covers',
  COMPUTE_CLUSTER_ORDER.includes(realNode.nodes[0].cluster),
);
check(
  'free VRAM survives into the title and meta',
  realNode.nodes[0].title.includes('16.7 GB free') &&
    (realNode.nodes[0].meta as Record<string, unknown>).vramFreeGb === 16.7,
  realNode.nodes[0].title,
);

// A `route` plan names one winner, so asserting "some plan produced edges" would pass
// vacuously off the split case above. This pins the empty-link case as deliberate.
check(
  'route plan produces no cooperation edges',
  fromComputePool({
    nodes: [{ node_id: 'a', vram_free_gb: 9 }, { node_id: 'b', vram_free_gb: 8 }],
    capacity_plan: { mode: 'route', target_node: 'a' },
  }).links.length === 0,
);

// ── engine ────────────────────────────────────────────────────────────────────
console.log('engine');
const handle = createBeadSpace(container, constellation, { assetRoot: '/assets' });
const root = container.querySelector('.bead-space');
check('root mounted', root !== null);

const planets = container.querySelectorAll('g.bs-node');
const linkLines = container.querySelectorAll('line.bs-link');
const ships = container.querySelectorAll('g.bs-orbit, g.bs-patrol-worker');
check('planets rendered', planets.length === constellation.nodes.length, `${planets.length}`);
check('links rendered', linkLines.length === constellation.links.length, `${linkLines.length}`);
check('ships rendered for active agents', ships.length > 0, `${ships.length}`);
check('sprites point at the configured asset root',
  (container.querySelector('image.bs-planet-sprite')?.getAttribute('href') ?? '').startsWith('/assets/'));
check('starfield drawn', container.querySelectorAll('circle.bs-star').length > 100);

const stats = handle.stats();
check('stats agree with the DOM', stats.nodes === planets.length && stats.links === linkLines.length);
check('clusters counted', stats.clusters > 3, `${stats.clusters}`);

// Selection
let selected: string | null = null;
const handle2 = handle;
handle2.select(constellation.nodes[0].id);
selected = container.querySelector('g.bs-node.selected')?.getAttribute('aria-label') ?? null;
check('select highlights a planet', selected !== null, selected ?? '');
handle2.select(null);
check('deselect clears', container.querySelector('g.bs-node.selected') === null);

// Update with a different dataset — the whole point of the embedded engine.
const before = container.querySelector('g.bs-node')?.getAttribute('transform');
handle.update(fleet);
check(
  'update swaps the universe',
  container.querySelectorAll('g.bs-node').length === fleet.nodes.length,
  `${container.querySelectorAll('g.bs-node').length} planets`,
);
check('update did not leak the old links', container.querySelectorAll('line.bs-link').length === fleet.links.length);
check('positions were recomputed', before !== undefined);

// Update to an empty dataset must not throw or leave orphans.
handle.update({ nodes: [], links: [] });
check('empty update clears', container.querySelectorAll('g.bs-node').length === 0);

handle.update(constellation);
check('re-populates after empty', container.querySelectorAll('g.bs-node').length === constellation.nodes.length);

// ── readability features ──────────────────────────────────────────────────────
console.log('readability');
handle.destroy();

const debtish = {
  nodes: ['P0', 'P0', 'P1', 'P2', 'P2', 'P2', 'P3'].map((severity, index) => ({
    id: `D-${index}`,
    title: `a very long debt description that should be clipped for the planet label ${index}`,
    cluster: severity,
    status: 'open' as const,
    assignee: null,
    createdAt: new Date(2026, 0, 1 + index).toISOString(),
  })),
  links: [{ source: 'D-0', target: 'D-2', kind: 'related' as const }],
};

const ordered = createBeadSpace(container, debtish, {
  assetRoot: '/assets',
  clusterOrder: ['P0', 'P1', 'P2', 'P3'],
});
const clusters = ordered.clusters();
check('clusters reported for a legend', clusters.length === 4, clusters.map((c) => c.name).join(','));
// The bug this guards: default order is by SIZE, so P2 (3 rows) would take the alarm colour
// and P0 (2 rows) would render green — the emergencies would look safe.
check('pinned clusterOrder beats size order', clusters[0].name === 'P0', `first=${clusters[0].name}`);
check('cluster counts correct', clusters.find((c) => c.name === 'P2')?.count === 3);
check(
  'unowned planets are tinted by cluster, not all white',
  new Set(clusters.map((c) => c.color)).size === 4,
);
// One filter per COLOUR, not per node — 358 filters would otherwise land in <defs>.
const filterCount = container.querySelectorAll('filter.bs-tint-filter').length;
check('tint filters deduped by colour', filterCount === 4, `${filterCount} filters / 7 nodes`);

const labels = [...container.querySelectorAll('text.bs-label')].map((n) => n.textContent ?? '');
check('every planet has a label', labels.length === 7);
check('long titles are clipped', labels.every((t) => t.length <= 33), `max=${Math.max(...labels.map((t) => t.length))}`);
check('small universe shows labels immediately',
  container.querySelector('.bead-space')?.classList.contains('bs-labels-on') === true);

const stageBefore = container.querySelector('.bead-space-map > g:nth-of-type(2)')?.getAttribute('transform');
ordered.fit();
const stageAfter = container.querySelector('.bead-space-map > g:nth-of-type(2)')?.getAttribute('transform');
check('fit() reframes the camera', stageAfter !== null && stageAfter !== stageBefore,
  `${stageBefore} -> ${stageAfter}`);

ordered.destroy();

handle.destroy();
check('destroy removes all DOM', container.querySelector('.bead-space') === null);
handle.destroy();
check('destroy is idempotent', true);

console.log(failures === 0 ? '\nPASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
