# @aitherium/bead-space

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
import { createBeadSpace } from '@aitherium/bead-space';
import '@aitherium/bead-space/bead-space.css';

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
import { BeadSpace, useBeadData } from '@aitherium/bead-space/react';
import '@aitherium/bead-space/bead-space.css';

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
| `fromDebtLedger` | debt ledger JSON (`{items}` with severity `P0`–`P3` and `file` paths) | Debt rows have no dependencies, so rows sharing a file are cross-linked. **Pass `clusterOrder: ['P0','P1','P2','P3']`** — see the warning below. |
| `fromConstellation` | `GET /api/constellation` → `config/constellation.yaml` | **ring** drives radial distance; `active` agents own themselves so they get ships. |
| `fromFleet` | `config/services.yaml` + live health | **layer** drives radial distance; a dependency turns `blocks` only when the upstream is actually down. |
| `fromScopeGraph` | `GET /scope/graph/{full,unified,subproject}` | Accepts both `connections` (pydantic) and `edges` (hand-built dict) — the two endpoints disagree. Circular deps render as blockers. |
| `fromRegistry` | AitherRegistry catalogue | `depends_on`/`requires` → hierarchy. |
| `fromGenericGraph` | anything `{nodes, edges}` | configurable field mapping — AitherGraph, codegraph, knowledge graph. |
| `fromPipelineUniverse` | `GET /tunnel/training/universe` (`aither.pipeline-universe/v1`, `lib/training/pipeline_universe.py`) | Training pipeline: lanes finetune/teachers/eval/data/workflows (**pass `clusterOrder: PIPELINE_CLUSTER_ORDER`**); task -> run -> checkpoint hierarchy; unmet dependency = `blocks`, met = `related`; GPU/agent = ship; a non-terminal run silent past `staleAfterMs` (default 10 min) or flagged `stale` by the server turns `blocked`. Test: `npm run test:pipeline`. Browser bundle for the tunnel: `npm run build:tunnel`. |
| `fromWorkUniverse` | `GET /api/beadspace/graph` (Genesis `routers/beadspace.py`, `lib/beadspace/adapter.py`) | The agents' REAL work: Atlas PM items (stage -> the agent holding it), TaskHub, agent-salon threads, agent-written beads; one constellation per agent. Server already speaks this contract, so the adapter only validates. `view=public` is an allowlist (internal titles replaced, ids hashed); `view=operator` needs a platform operator. Pin `WORK_UNIVERSE_CLUSTER_ORDER`. |
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

## The universe (0.2.0): explore, don't menu

Three new entries sit beside the 2D engine and change nothing about it (`src/index.ts`
does not re-export them, so a consumer of `.` pulls no React and no three):

| entry | what | needs |
|---|---|---|
| `@aitherium/bead-space/universe` | the pure model: levels, deterministic layout, the shared selection reducer, search, verbs, card attachment | nothing (no DOM, no React) |
| `@aitherium/bead-space/space` | `SpaceSwitch` (3D ↔ 2D), `Space3D`, `Space2D`, `SelectionPanel`, the HUD | React 18/19, optional peers `three` + `@react-three/fiber` (no drei) |
| `@aitherium/bead-space/space2d` | `Space2D`, `SelectionPanel`, and the HUD without `three` or `@react-three/fiber` in the import graph | React 18/19 |

**Contract U1.** A universe is `BeadData` plus `level` (universe → galaxy → solar → system →
moon), `parent`, `health` (`ok|degraded|down|starting|parked|unknown`, where unknown is drawn
hollow and never green), `verbs[]` and `explore[]` per node, and `rel` per link
(`depends|hosts|serves|traffic|routes`). Decision cards are attached client-side by
`attachCards(data, cards, order)`: `subjectOf` tries the card's explicit `subject`, then
credential → `secret:<name>`, the dedupe-key / recipe prefix table, a known agent, a service
named in the text (whole word, longest first), the session, the cwd, the host, and finally
`platform`. A subject with no node gets a virtual moon under the right parent. Card text never
leaves the client.

**Layout is deterministic, not simulated.** Galaxies sit on a Fibonacci sphere around the
root; every other parent's children on a tilted ring whose radius grows with sqrt of the child
count quantised to the next power of two. A child's angle comes from `hash(id)` alone, so a new
sibling moves nobody else unless the count crosses 4, 8, 16, … (tested: 300 nodes in < 5 ms).

**One obvious action.** The selection panel shows at most five blocks: name + one state
sentence; the top ask (recommended option as the big button, ≤ 2 ghost chips, the rest behind
`other…`; a credential ask is an uncontrolled masked field whose value goes to `onCredential`
once and is cleared, and only `{ok: true}` reads as `stored · card closed`); the primary verb
plus ≤ 2 more (a `confirm` verb arms on the first click and sends `confirmed: true` on a second
within 6 s); `Explore with Aither`; an impact line. The package executes nothing; every action
is a host callback returning a promise.

**3D budget.** `frameloop="demand"`: one instanced icosahedron mesh (Fresnel rim) plus one
wireframe instanced mesh for unknown health, one line set per link style, additive point
sprites for atmospheres, beacons, matches, comets and the ship. A 30 fps timer runs only while
a beacon, comet or ship is moving; `prefers-reduced-motion` stops all of it and turns camera
flights into cuts. No WebGL, or under 30 fps for 3 s, fires `onFallback` and the host shows the
dependency-free SVG view. Keys: arrows step siblings, Enter descends, Esc/Backspace ascends,
`/` searches, Space flies to the next ask, V toggles 3D/2D.

**Vendored into awdesk.** `types.ts`, `core/hash.ts`, `universe/` and `space/` are
vendored into the awdesk source tree with a GENERATED header; edit here and re-run the
vendoring sync rather than editing the downstream copy.

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

The demo harness (`demo/`) switches between four universes — an open debt ledger, an
agent constellation, a service fleet, and one synthetic set. Run `npm run demo:data`
to rebuild the demo fixtures from your local environment.

The synthetic source exists for a reason worth keeping: **no live dataset produces a patrol.**
Constellation agents own only themselves and fleet services have no owner, so the multi-stop
flight-path routing — the most intricate code here — is exercised by nothing real. Delete that
source and that code silently stops being tested.

### Visual verification

jsdom has no layout engine, so the geometry needs eyes. With `npm run demo`
serving `http://127.0.0.1:8099/demo/`, capture a screenshot directly with
headless Chrome/Chromium:

```bash
google-chrome --headless=new --disable-gpu \
  --hide-scrollbars --virtual-time-budget=20000 --window-size=1600,1000 \
  --screenshot=shot-debt.png "http://127.0.0.1:8099/demo/?source=debt"
```

Inspect the rendered screenshot to verify framing, cluster colours, labels, and
severity constellation separation.
