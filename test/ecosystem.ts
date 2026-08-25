/**
 * The ecosystem adapter, against the REAL registry.
 *
 * A POSITIVE test on purpose, for the same reason smoke.ts is one: an adapter
 * that returned an empty universe would pass any "no exceptions thrown" check,
 * and an empty background is exactly what this feature would look like if it
 * silently broke.
 *
 *   npx esbuild test/ecosystem.ts --bundle --platform=node --format=esm \
 *     --outfile=test/ecosystem.mjs && node test/ecosystem.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fromEcosystem, withEcosystem, type EcosystemBrickRecord } from '../src/adapters';
import type { BeadData } from '../src/types';

const here = dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (!cond) failures += 1;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  ${detail}`}`);
}

/** Read the real registry rather than a fixture, so drift shows up here. */
function realBricks(): EcosystemBrickRecord[] {
  const path = join(here, '..', '..', '..', '..', 'config', 'ecosystem.yaml');
  const text = readFileSync(path, 'utf8');
  // A deliberately small reader: this test asserts the ADAPTER, and pulling a
  // yaml dependency into a package that ships to browsers to read one file in
  // one test would be a real cost for no gain.
  const bricks: EcosystemBrickRecord[] = [];
  let cur: EcosystemBrickRecord | null = null;
  let listKey: 'pairs_with' | 'includes' | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    // `stacks:` reuses `- id:` for a different kind of thing. Reading past it
    // inflates the brick count (36 against a real 28). Nothing downstream broke,
    // because a stack has no `status: public` and is filtered out anyway — which
    // is precisely why it is worth stopping here: the assertions stayed green
    // while the number printed above them was wrong, and a number nobody can
    // trust is worse than no number.
    if (/^stacks:/.test(line)) break;
    const id = /^ {2}- id:\s*(\S+)\s*$/.exec(line);
    if (id) {
      cur = { id: id[1] };
      bricks.push(cur);
      listKey = null;
      continue;
    }
    if (!cur) continue;
    const kv = /^ {4}(\w+):\s*(.*)$/.exec(line);
    if (kv) {
      const [, key, value] = kv;
      listKey = null;
      if (key === 'status') cur.status = value.trim();
      else if (key === 'kind') cur.kind = value.trim();
      else if (key === 'tagline') cur.tagline = value.trim();
      else if (key === 'pairs_with' || key === 'includes') {
        // The registry writes these INLINE (`pairs_with: [a, b]`), not as block
        // items. A block-only reader finds zero links and the graph renders as
        // unconnected dust -- which looks like a layout bug, not a parse bug.
        const inline = /^\[(.*)\]$/.exec(value.trim());
        if (inline) {
          (cur as Record<string, unknown>)[key] =
            inline[1].split(',').map((x) => x.trim()).filter(Boolean);
        } else {
          (cur as Record<string, unknown>)[key] = [];
          listKey = key;
        }
      }
      continue;
    }
    const item = /^ {6}- (\S+)\s*$/.exec(line);
    if (item && listKey) (cur[listKey] as string[]).push(item[1]);
  }
  return bricks;
}

const bricks = realBricks();
console.log(`registry: ${bricks.length} brick(s)`);
check('the registry parsed to something', bricks.length >= 20, `${bricks.length}`);

const data = fromEcosystem(bricks);
check('the ecosystem renders nodes at all', data.nodes.length > 0, `${data.nodes.length}`);

const shipped = bricks.filter((b) => b.status === 'public' || b.status === 'no-pages');
check('every shipped brick is a node, and only those',
  data.nodes.length === shipped.length, `${data.nodes.length} vs ${shipped.length}`);
check('unbuilt bricks are excluded by default',
  !data.nodes.some((n) => String(n.meta?.rawStatus) === 'planned'));
check('...but renderable on request',
  fromEcosystem(bricks, { includeUnbuilt: true }).nodes.length > data.nodes.length);

check('ids are namespaced so a brick cannot collide with a service',
  data.nodes.every((n) => n.id.startsWith('aw:')));
check('bricks split across clusters by kind, not one blob',
  new Set(data.nodes.map((n) => n.cluster)).size > 1);
check('a public brick carries its page link',
  data.nodes.some((n) => String(n.meta?.rawStatus) === 'public' && !!n.href));
check('a brick with no site gets NO href rather than a dead one',
  data.nodes.filter((n) => String(n.meta?.rawStatus) === 'no-pages')
    .every((n) => !n.href));

// Links. The registry declares pairs_with on BOTH sides of a pairing, so the
// interesting assertion is that the graph is not doubled.
const related = data.links.filter((l) => l.kind === 'related');
const dupes = related.filter((l, i) =>
  related.findIndex((o) =>
    (o.source === l.source && o.target === l.target) ||
    (o.source === l.target && o.target === l.source)) !== i);
check('symmetric pairings are not drawn twice', dupes.length === 0, `${dupes.length}`);

const ids = new Set(data.nodes.map((n) => n.id));
check('no link reaches a node that is not rendered',
  data.links.every((l) => ids.has(l.source) && ids.has(l.target)));
check('there are real links, not just nodes', data.links.length > 0, `${data.links.length}`);

// Merging into an interior universe: the whole point of the feature.
const inner: BeadData = {
  nodes: [{ id: 'genesis', title: 'Genesis', cluster: 'core', status: 'done',
            createdAt: new Date().toISOString() }],
  links: [],
};
const merged = withEcosystem(inner, data);
check('merging keeps the interior', merged.nodes.some((n) => n.id === 'genesis'));
check('merging adds the ecosystem', merged.nodes.length === inner.nodes.length + data.nodes.length);
const twice = withEcosystem(merged, data);
check('merging twice does not duplicate', twice.nodes.length === merged.nodes.length);

// ── does it actually RENDER? ─────────────────────────────────────────────────
// Well-shaped data and a drawn universe are different claims, and smoke.ts
// already established this lane for the interior sources. Without it an adapter
// can be perfect and the background still empty — which is exactly what a silent
// break looks like here, and the reason every check above is a positive one.
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="stage"></div></body></html>',
  { pretendToBeVisual: true });
const { window } = dom;
const container = window.document.querySelector('#stage') as HTMLElement;
// jsdom has no layout engine, so give it a real box to exercise the measured path.
container.getBoundingClientRect = () =>
  ({ width: 1280, height: 800, top: 0, left: 0, right: 1280, bottom: 800,
     x: 0, y: 0 }) as DOMRect;
const g = globalThis as unknown as Record<string, unknown>;
for (const key of ['window', 'document', 'navigator', 'SVGElement', 'HTMLElement',
                   'Element', 'Node']) {
  if (g[key] === undefined) g[key] = (window as unknown as Record<string, unknown>)[key];
}
if (g.requestAnimationFrame === undefined) {
  g.requestAnimationFrame = (cb: (t: number) => void) => window.setTimeout(() => cb(0), 16);
  g.cancelAnimationFrame = (id: number) => window.clearTimeout(id);
}

// ---- packs -----------------------------------------------------------------
// A pack is not a brick: it runs INSIDE a runtime, so it gets its own orbit and
// a solid containment edge from that runtime. Both directions are asserted,
// because an adapter that dropped every pack and one that rendered them as
// bricks are indistinguishable from a node count alone.
const packRecords = [
  { id: 'gobbonet', status: 'preview', summary: 'a pack', runtime: 'awdk>=3.8.0',
    install: 'adk gobbonet', tools: ['campaign_note'] },
  { id: 'secretpack', status: 'internal', summary: 'never offered', runtime: 'awdk' },
];
const withPacks = fromEcosystem(realBricks(), { packs: packRecords });
const packNodes = withPacks.nodes.filter((n) => n.meta?.kind === 'pack');
check('a shelved pack renders', packNodes.length === 1,
      `${packNodes.length} pack node(s)`);
check('an INTERNAL pack is absent, not merely marked',
      !withPacks.nodes.some((n) => n.id === 'awpack:secretpack'));
check('a pack orbits separately from the bricks',
      packNodes[0] !== undefined && /· pack$/.test(packNodes[0].cluster ?? ''),
      packNodes[0]?.cluster ?? '(none)');
check('the runtime CONTAINS the pack (solid edge, awdk -> gobbonet)',
      withPacks.links.some((l) => l.source === 'aw:awdk'
        && l.target === 'awpack:gobbonet' && l.kind === 'parent-child'));
check('passing no packs leaves the graph exactly as it was',
      fromEcosystem(realBricks()).nodes.length
        === withPacks.nodes.length - packNodes.length);
// A pack whose runtime is not on this map must not draw a line into space.
const orphan = fromEcosystem(realBricks(), {
  packs: [{ id: 'lonely', status: 'preview', runtime: 'nosuchbrick' }],
});
check('a pack whose runtime is absent renders with no dangling link',
      orphan.nodes.some((n) => n.id === 'awpack:lonely')
        && !orphan.links.some((l) => l.target === 'awpack:lonely'));

const { createBeadSpace } = await import('../src/core/bead-space');
const handle = createBeadSpace(container, data, { assetRoot: '/assets' });
check('the ecosystem actually renders planets',
  container.querySelectorAll('g.bs-node').length === data.nodes.length,
  `${container.querySelectorAll('g.bs-node').length} vs ${data.nodes.length}`);
check('...and its links',
  container.querySelectorAll('line.bs-link').length === data.links.length,
  `${container.querySelectorAll('line.bs-link').length} vs ${data.links.length}`);

// The merged universe IS the feature: AitherOS inside, the aw* family around it.
handle.update(merged);
check('the merged universe renders both interior and ecosystem',
  container.querySelectorAll('g.bs-node').length === merged.nodes.length,
  `${container.querySelectorAll('g.bs-node').length} vs ${merged.nodes.length}`);
handle.destroy();

console.log(`\n${failures === 0 ? 'PASSED' : `FAILED (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
