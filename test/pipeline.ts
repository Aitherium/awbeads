/**
 * Pipeline-universe adapter test: the shared `aither.pipeline-universe/v1` document
 * (written by `python AitherOS/lib/training/pipeline_universe.py --sample`) must map to a
 * universe with the lanes, the hierarchy, the blockers and the ships the owner asked for,
 * AND must actually render (positive DOM assertions, like smoke.ts).
 *
 * The fixture is checked in and pinned from the Python side
 * (dev/tests/test_pipeline_universe.py asserts it equals sample_document()), so the two
 * languages cannot drift apart silently.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';

import type { PipelineUniverseRecord } from '../src/adapters';

const here = dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(
  readFileSync(join(here, 'fixtures', 'pipeline-universe.sample.json'), 'utf-8'),
) as PipelineUniverseRecord;

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// jsdom globals BEFORE the engine module loads (d3 reads them at import).
const dom = new JSDOM('<!doctype html><html><body><div id="stage"></div></body></html>', {
  pretendToBeVisual: true,
});
const { window } = dom;
const container = window.document.querySelector('#stage') as HTMLElement;
container.getBoundingClientRect = () =>
  ({ width: 1280, height: 800, top: 0, left: 0, right: 1280, bottom: 800, x: 0, y: 0 }) as DOMRect;
const g = globalThis as Record<string, unknown>;
g.window = window;
g.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true });
g.requestAnimationFrame = window.requestAnimationFrame.bind(window);
g.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
for (const name of ['Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'Node', 'Element',
  'HTMLElement', 'SVGElement', 'SVGSVGElement', 'DOMRect'] as const) {
  g[name] = (window as unknown as Record<string, unknown>)[name];
}

const { fromPipelineUniverse, PIPELINE_CLUSTER_ORDER, PIPELINE_SCHEMA } = await import('../src/adapters');
const { createBeadSpace } = await import('../src/core/bead-space');

// "now" = the sample's generated_at, so the stale rule is deterministic.
const NOW = Date.parse('2026-09-25T18:30:30+00:00');

console.log('pipeline adapter');
check('fixture is the shared schema', doc.schema === PIPELINE_SCHEMA, String(doc.schema));
const data = fromPipelineUniverse(doc, { now: NOW });
const byId = new Map(data.nodes.map((n) => [n.id, n]));
const ids = new Set(byId.keys());

check('every task, run and checkpoint is a planet',
  data.nodes.length === (doc.tasks?.length ?? 0) + (doc.runs?.length ?? 0) + 2,
  `${data.nodes.length}`);
check('ids are unique', ids.size === data.nodes.length);
check('no link reaches a node that is not rendered',
  data.links.every((l) => ids.has(l.source) && ids.has(l.target)));

const clusters = new Set(data.nodes.map((n) => n.cluster));
check('all five lanes present', PIPELINE_CLUSTER_ORDER.every((c) => clusters.has(c)), [...clusters].join(','));
check('no stray lanes', [...clusters].every((c) => PIPELINE_CLUSTER_ORDER.includes(c)));

// hierarchy: task -> run -> checkpoint
const live = byId.get('run:orch-20260925T171000Z');
check('the live Lambda run is in the finetune lane', live?.cluster === 'finetune');
check('the live run is in_progress with its GPU as the ship',
  live?.status === 'in_progress' && live.assignee === 'gpu_1x_h100_sxm5', `${live?.status}/${live?.assignee}`);
check('re-executed attempts hang under ONE task',
  ['run:orch-20260925T171000Z', 'run:orch-20260925T162000Z'].every((r) =>
    data.links.some((l) => l.source === 'task:coder-lora-v1' && l.target === r && l.kind === 'parent-child')));
check('the task takes the NEWEST attempt\'s state, not the failed first one',
  byId.get('task:coder-lora-v1')?.status === 'in_progress');
check('checkpoints hang under their run',
  data.links.filter((l) => l.source === 'run:orch-20260925T171000Z' && l.target.startsWith('ckpt:')).length === 2);
check('a checkpoint that scored below base is drawn as a blocker',
  byId.get('ckpt:orch-20260925T171000Z#ckpt-200')?.status === 'blocked');
check('a checkpoint that beat base is done', byId.get('ckpt:orch-20260925T171000Z#ckpt-400')?.status === 'done');
check('the failed attempt has no ship', byId.get('run:orch-20260925T162000Z')?.assignee === null);

// dependencies
const edge = (s: string, t: string) => data.links.find((l) => l.source === s && l.target === t);
check('teacher trajectories BLOCK tool_lora training', edge('task:trajectories', 'task:tool-lora')?.kind === 'blocks');
check('an unfinished teacher blocks the trajectories', edge('task:teacher-bonsai2', 'task:trajectories')?.kind === 'blocks');
check('a satisfied dependency reads as history, not a blocker',
  edge('task:comp-download', 'task:taskpool')?.kind === 'related',
  `download done via telemetry -> ${edge('task:comp-download', 'task:taskpool')?.kind}`);
check('the bulk download is done from telemetry', byId.get('task:comp-download')?.status === 'done');

// ships
const shipOwners = new Set(data.nodes.filter((n) => n.status === 'in_progress' && n.assignee).map((n) => n.assignee));
check('the teacher rollout orbits the 5090', byId.get('run:teacher-bonsai2-r1')?.assignee === 'rtx5090');
check('the Claude Code workflow is a ship', shipOwners.has('claude-code'));
check('the GPU patrols its task AND its run', data.nodes.filter((n) => n.assignee === 'gpu_1x_h100_sxm5').length === 2);

// unknown is never guessed as done
check('a task with no telemetry and no artifact is open, flagged unknown',
  byId.get('task:replica-eval')?.status === 'open' &&
  byId.get('task:replica-eval')?.meta?.statusSource === 'unknown');

// stale driver
const later = fromPipelineUniverse(doc, { now: NOW + 3 * 3_600_000 });
const stale = later.nodes.find((n) => n.id === 'run:orch-20260925T171000Z');
check('a run silent past staleAfterMs stops orbiting and turns blocked',
  stale?.status === 'blocked' && stale.assignee === null && stale.meta?.stale === true, stale?.title);
check('a run the server already judged stale is blocked even on a skewed browser clock',
  fromPipelineUniverse({ ...doc, runs: doc.runs.map((r: any) => r.run_id === 'orch-20260925T171000Z'
    ? { ...r, stale: true } : r) }, { now: NOW }).nodes
    .find((n) => n.id === 'run:orch-20260925T171000Z')?.status === 'blocked');
check('staleAfterMs: 0 disables the rule',
  fromPipelineUniverse(doc, { now: NOW + 3 * 3_600_000, staleAfterMs: 0 }).nodes
    .find((n) => n.id === 'run:orch-20260925T171000Z')?.status === 'in_progress');

// leniency: a live endpoint may hand back partial or junk records
const junk = fromPipelineUniverse({ runs: [null as never, { run_id: '' }, { run_id: 'x' }], tasks: [{ id: '' } as never] });
check('junk records are dropped, valid ones kept', junk.nodes.length === 1 && junk.nodes[0].id === 'run:x');
check('an empty document is an empty universe', fromPipelineUniverse({}).nodes.length === 0);
check('checkpoints: false draws none',
  fromPipelineUniverse(doc, { now: NOW, checkpoints: false }).nodes.every((n) => !n.id.startsWith('ckpt:')));

// ── render ────────────────────────────────────────────────────────────────────
console.log('pipeline render');
const handle = createBeadSpace(container, data, { assetRoot: '/assets', clusterOrder: PIPELINE_CLUSTER_ORDER });
check('planets rendered', container.querySelectorAll('g.bs-node').length === data.nodes.length);
check('links rendered', container.querySelectorAll('line.bs-link').length === data.links.length);
check('ships rendered for active work', container.querySelectorAll('g.bs-orbit, g.bs-patrol-worker').length > 0);
const stats = handle.stats();
check('stats count the patrol (one GPU, two active planets)', stats.patrols >= 1, JSON.stringify(stats));
check('legend colours follow the pinned lane order',
  handle.clusters().map((c) => c.name).slice(0, 5).join(',') === PIPELINE_CLUSTER_ORDER.join(','),
  handle.clusters().map((c) => c.name).join(','));
handle.update(later);
check('update keeps the universe', container.querySelectorAll('g.bs-node').length === later.nodes.length);
handle.destroy();
check('destroy removes all DOM', container.querySelector('.bead-space') === null);

console.log(failures === 0 ? '\nPASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
