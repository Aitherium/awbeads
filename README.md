# @aitheros/bead-space

An embeddable force-graph **universe**. Nodes are planets, dependencies are flight paths, and
whoever is actively working a node gets a ship orbiting it.

Ported from [bead-space](https://github.com/wbern/bead-space) (MIT) — see `NOTICE.md` for
exactly what changed and why. Sprites are Kenney's Simple Space (CC0).

## Why this exists

Every graph surface in this repo was hand-rolled and single-purpose: `/galaxy` renders a
hardcoded innovations array, `/neural` and `neuralnet` each run their own bespoke canvas
physics, `awkit` has `KnowledgeGraphCanvas`, AitherScope has its own renderer. Same
problem solved five times, none of them shared.

This is one engine with a five-field data contract, and an adapter per data source.

## Visual language

| element | meaning |
|---|---|
| planet | a node; **radial distance from the cluster core = age** (older is nearer the core) |
| constellation | a `cluster` — independent streams get their own anchor instead of one blob |
| solid line | `parent-child` (hierarchy) |
| orange dashed | `blocks` (a blocker) |
| purple dashed | `related` (cross-link) |
| orbiting ship | an owner with exactly **one** active node |
| patrolling ship | an owner across **several** active nodes — one full orbit at each, then a routed flight to the next, trailing behind them |
| slow station | active but **unassigned** work |
| planet tint | the owner's colour |
| slower orbit | an **older** assignment |

Routes are computed to steer around intervening planets, memoised against a quantised
position signature, and locked once the layout settles — the clearance search is the
expensive part, so it must not run every frame.

## Usage

### Vanilla

```ts
import { createBeadSpace } from '@aitheros/bead-space';
import '@aitheros/bead-space/bead-space.css';

const universe = createBeadSpace(containerEl, { nodes, links }, {
  assetRoot: '/assets/kenney-simple-space',
  onSelect: (node) => console.log(node?.id),
  onStats: (stats) => console.log(`${stats.active} active, ${stats.patrols} patrolling`),
});

universe.update(nextData);   // planets keep their positions; the sim only gets a nudge
universe.destroy();          // cancels the rAF loop, the sim and the ResizeObserver
```

### React

```tsx
import { BeadSpace, useBeadData } from '@aitheros/bead-space/react';
import '@aitheros/bead-space/bead-space.css';

const { data } = useBeadData('/api/work-graph', { intervalMs: 15_000 });
return <BeadSpace data={data} style={{ height: '100%' }} onSelect={openTask} />;
```

The universe is created once and fed through `update()`; it is deliberately **not** rebuilt
on every render, so a poll does not re-explode the layout or reset ship orbits.

### Assets

Copy `assets/kenney-simple-space/` into the host's public directory and point `assetRoot`
at it. Next.js: `public/assets/kenney-simple-space/`.

## Data contract

```ts
interface BeadNode {
  id: string; title: string; cluster: string;
  status: 'open' | 'in_progress' | 'blocked' | 'deferred' | 'done';
  assignee?: string | null;      // drives ships + planet tint
  createdAt: string;             // ISO — drives radial distance
  stateStartedAt?: string | null;// ISO — drives orbit speed
  href?: string; meta?: Record<string, unknown>;
}
interface BeadLink { source: string; target: string; kind: 'parent-child' | 'blocks' | 'related' }
```

Links whose endpoints are not in `nodes` are dropped (d3-force would otherwise throw).

## Adapters

All pure functions — feed them what an endpoint returned, get `BeadData` back.

| adapter | source | notes |
|---|---|---|
| `fromExpeditionTasks` | `GET /expedition/{id}/tasks` (Genesis :8001) | SQLite-backed; **the only work store with real dependencies**. `depends_on` → `blocks`. |
| `fromTaskHub` | `GET /tasks` (Genesis :8001) | ⚠️ **in-memory** — a Genesis restart empties it. Parent/child only, no blockers. |
| `fromDebtLedger` | `python AitherOS/dev/tools/debt_graph.py` (522 rows; `--state open` → 358) | Debt rows have no dependencies, so rows sharing a file are cross-linked. **Pass `clusterOrder: ['P0','P1','P2','P3']`** — see the warning below. |
| `fromConstellation` | `GET /api/constellation` → `config/constellation.yaml` | **ring** drives radial distance; `active` agents own themselves so they get ships. |
| `fromFleet` | `config/services.yaml` + live health | **layer** drives radial distance; a dependency turns `blocks` only when the upstream is actually down. |
| `fromScopeGraph` | `GET /scope/graph/{full,unified,subproject}` | Accepts both `connections` (pydantic) and `edges` (hand-built dict) — the two endpoints disagree. Circular deps render as blockers. |
| `fromRegistry` | AitherRegistry catalogue | `depends_on`/`requires` → hierarchy. |
| `fromGenericGraph` | anything `{nodes, edges}` | configurable field mapping — AitherGraph, codegraph, knowledge graph. |
| `mergeWorkGraphs` | — | namespaces ids/clusters so several sources can share one universe. |

### Colour, and the trap in it

Upstream tinted planets by **owner** only. Most AitherOS data has no owner — a debt row, a
service, a module — so every planet came out identical white and the most important dimension
was carried by position alone. Planets are now tinted by owner if they have one, **by cluster
otherwise**, and `handle.clusters()` returns `{name, color, count}` so you can draw a legend.
Colour without a legend is decoration, not information.

> ⚠️ **Ordinal clusters need `clusterOrder`.** Colours are assigned in cluster order, and the
> default order is *by size*. On the real debt ledger that painted P2 (149 rows) with the alarm
> colour and P0 (22 rows) green — the emergencies looked safe. Any severity/priority/layer
> cluster must pin the order explicitly. There is a regression test for this.

### Reading the map

- **Labels** appear under each planet, and are hidden on a crowded map until you zoom past
  `labelZoom` (default 1.6). Below `labelsAlwaysBelow` nodes (default 60) they are always on.
  Override the text with `nodeLabel` — for ledger data the id plus an area prefix beats a
  truncated paragraph.
- **The camera fits the content** automatically as the layout settles, and yields the moment
  you touch it. `handle.fit()` reframes on demand. Disable with `fitToContent: false`.

### Synthetic timestamps

Structural graphs (fleet, scope, constellation, registry) have no timestamps, but radial
distance is the layout's strongest encoding. Those adapters project a numeric metric — ring,
layer, lines of code, size — onto a synthetic `createdAt`, flagged as
`meta.syntheticCreatedAt: true`. **Never surface those as real dates.**

## Verify

```bash
npm install
npm run check          # tsc --noEmit + the headless smoke test
npm run demo           # → http://127.0.0.1:8099/demo/
```

`npm test` renders the **real** agent constellation and the **real** 260-service fleet into
jsdom and asserts planets, links, ships, stations, stats, labels, cluster colours, select,
update, fit and destroy — **positive** assertions, because a renderer that silently draws
nothing passes any "no exception" check. Two of them are regressions for bugs a screenshot
caught and the test suite had not: severity colour ordering, and `fit()` not reframing.

The demo harness (`demo/`) switches between four universes — the real open debt ledger, the
real agent constellation, the real service fleet, and one synthetic set. Run `npm run demo:data`
to refresh from `config/` + `docker ps`, and `python AitherOS/dev/tools/debt_graph.py
--state open --out demo/data/debt.json` for the ledger.

The synthetic source exists for a reason worth keeping: **no live dataset produces a patrol.**
Constellation agents own only themselves and fleet services have no owner, so the multi-stop
flight-path routing — the most intricate code here — is exercised by nothing real. Delete that
source and that code silently stops being tested.

### Visual verification

jsdom has no layout engine, so the geometry needs eyes. Neither browser-automation path on this
box works (the Claude Chrome extension is not connected; AitherBrowser :8132 is down), but
headless Chrome directly does, and needs neither:

```bash
"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --disable-gpu \
  --hide-scrollbars --virtual-time-budget=20000 --window-size=1600,1000 \
  --screenshot=<abs-path>.png "http://127.0.0.1:8099/demo/?source=debt"
```

`demo/shot-*.png` are the checked-in results. Compare `shot-debt.png` (an unreadable white
starfield — before cluster colour, labels and fit) with `shot-fit.png` (the same 358 rows,
framed, four severity constellations, the 22 P0s legible as their own group).
