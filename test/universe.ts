/**
 * The pure universe model: levels, layout, selection, search, verbs, card attachment.
 *
 *   npx esbuild test/universe.ts --bundle --platform=node --format=esm --outfile=test/universe.mjs
 *   node test/universe.mjs
 */
import {
  attachCards,
  childrenOf,
  createSelectionReducer,
  glowCounts,
  initialSelection,
  layout2d,
  layout3d,
  pathTo,
  primaryAction,
  reduceSelection,
  search,
  subjectIndex,
  subjectOf,
  verbsFor,
  visibleAt,
} from '../src/universe';
import type { DeskCard, UniverseData } from '../src/types';
import { bigUniverse, check, finish, fixture, node } from './universe-fixture';

const data = fixture();

// ── levels ───────────────────────────────────────────────────────────────────
check('childrenOf platform = 6 galaxies', childrenOf(data, 'platform').length === 6);
check('childrenOf core = 3', childrenOf(data, 'solar:fleet/core').length === 3);
check('childrenOf leaf = 0', childrenOf(data, 'svc:Genesis').length === 0);
check(
  'pathTo moon',
  pathTo(data, 'model:llama').join('>') === 'platform>galaxy:fleet>solar:fleet/gpu>gpu:fleet/0>model:llama',
  pathTo(data, 'model:llama').join('>'),
);
check('pathTo unknown = []', pathTo(data, 'svc:nope').length === 0);

const atRoot = visibleAt(data, null);
check('visibleAt(null) focuses the root', atRoot?.focus.id === 'platform');
check('visibleAt root = 1 + 6', atRoot?.nodes.length === 7);
check('root has no ghosts', atRoot?.ghosts.length === 0);
// Traffic agent:atlas → svc:Genesis rolls up to galaxy:agents → galaxy:fleet at the root.
check(
  'links roll up to the visible level',
  atRoot?.links.some((l) => l.source === 'galaxy:agents' && l.target === 'galaxy:fleet' && l.rel === 'traffic') === true,
  JSON.stringify(atRoot?.links),
);
check('intra-galaxy links fold away at the root', atRoot?.links.every((l) => l.source !== l.target) === true);
const atCore = visibleAt(data, 'solar:fleet/core');
check('visibleAt core = focus + 3 children', atCore?.nodes.length === 4);
check('core ghosts = platform, fleet', atCore?.ghosts.map((g) => g.id).join(',') === 'platform,galaxy:fleet');
check('core links = genesis→scheduler only', atCore?.links.length === 1 && atCore.links[0].target === 'svc:MicroScheduler');
const orphan: UniverseData = { ...data, nodes: [...data.nodes, node('svc:lost', 'system', 'solar:missing')] };
check('a node with a missing parent becomes a root, not invisible', childrenOf(orphan, null).some((n) => n.id === 'svc:lost'));
const cyclic: UniverseData = {
  ...data,
  nodes: [...data.nodes, node('svc:a', 'system', 'svc:b'), node('svc:b', 'system', 'svc:a')],
};
check('pathTo is cycle-safe', pathTo(cyclic, 'svc:a').length <= 2);

// ── layout ───────────────────────────────────────────────────────────────────
const a = layout3d(data);
const b = layout3d(fixture());
check('layout3d length', a.length === data.nodes.length * 3);
check('layout3d deterministic (byte-identical)', Buffer.from(a.buffer).equals(Buffer.from(b.buffer)));
check('layout3d finite', [...a].every(Number.isFinite));
check('root at origin', a[0] === 0 && a[1] === 0 && a[2] === 0);

// Adding a node under a parent that stays in its radius bucket moves NOTHING else.
// solar:fleet/core has 3 children (bucket 4); a 4th keeps the bucket.
const grown: UniverseData = { ...fixture(), nodes: [...fixture().nodes, node('svc:Extra', 'system', 'solar:fleet/core')] };
const g = layout3d(grown);
let maxMove = 0;
for (let i = 0; i < data.nodes.length * 3; i += 1) maxMove = Math.max(maxMove, Math.abs(a[i] - g[i]));
check('adding a node moves siblings < epsilon', maxMove < 1e-4, `moved ${maxMove}`);
// Data order must not matter either.
const shuffled: UniverseData = { ...data, nodes: [...data.nodes].reverse() };
const s = layout3d(shuffled);
let orderMove = 0;
data.nodes.forEach((n, i) => {
  const j = shuffled.nodes.findIndex((m) => m.id === n.id);
  for (let k = 0; k < 3; k += 1) orderMove = Math.max(orderMove, Math.abs(a[i * 3 + k] - s[j * 3 + k]));
});
check('layout3d independent of data order', orderMove < 1e-4, `moved ${orderMove}`);
// Children sit near their parent, galaxies far from the root.
const at = (arr: Float32Array, id: string, d = data) => {
  const i = d.nodes.findIndex((n) => n.id === id);
  return [arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]];
};
const dist = (p: number[], q: number[]) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
const gd = dist(at(a, 'galaxy:fleet'), [0, 0, 0]);
check('galaxy on the (flattened) 1000 sphere', gd > 600 && gd <= 1000.01, String(gd));
check('system within its solar ring', dist(at(a, 'svc:Genesis'), at(a, 'solar:fleet/core')) < 60);

const big = bigUniverse(300);
layout3d(big); // warm-up (JIT)
const t0 = performance.now();
const bigLayout = layout3d(big);
const ms = performance.now() - t0;
check('300-node layout under 5 ms', ms < 5, `${ms.toFixed(2)} ms`);
check('300-node layout covers every node', bigLayout.length === 900);

const v2 = visibleAt(data, 'solar:fleet/core');
if (v2) {
  const l2a = layout2d(v2);
  const l2b = layout2d(visibleAt(fixture(), 'solar:fleet/core')!);
  check('layout2d deterministic', Buffer.from(l2a.buffer).equals(Buffer.from(l2b.buffer)));
  check('layout2d focus at origin', l2a[0] === 0 && l2a[1] === 0);
  check('layout2d children on ring 1', Math.abs(Math.hypot(l2a[2], l2a[3]) - 120) < 1e-3);
}

// ── selection ────────────────────────────────────────────────────────────────
let st = initialSelection(data);
check('initial focus = root', st.focusId === 'platform' && st.selectedId === null);
st = reduceSelection(data, st, { type: 'select', id: 'galaxy:fleet' });
check('select', st.selectedId === 'galaxy:fleet');
st = reduceSelection(data, st, { type: 'descend' });
check('descend into selection', st.focusId === 'galaxy:fleet' && st.selectedId === null && st.history.join() === 'platform');
st = reduceSelection(data, st, { type: 'descend', id: 'solar:fleet/core' });
check('descend by id', st.focusId === 'solar:fleet/core');
const leaf = reduceSelection(data, st, { type: 'descend', id: 'svc:Genesis' });
check('descend into a leaf selects it', leaf.focusId === 'solar:fleet/core' && leaf.selectedId === 'svc:Genesis');
st = reduceSelection(data, st, { type: 'ascend' });
check('ascend selects the level we left', st.focusId === 'galaxy:fleet' && st.selectedId === 'solar:fleet/core');
st = reduceSelection(data, st, { type: 'flyTo', id: 'model:llama' });
check('flyTo shows the parent level and selects', st.focusId === 'gpu:fleet/0' && st.selectedId === 'model:llama');
const same = reduceSelection(data, st, { type: 'select', id: 'model:llama' });
check('no-op returns the same state object', same === st);
const unknown = reduceSelection(data, st, { type: 'flyTo', id: 'svc:nope' });
check('flyTo unknown is a no-op', unknown === st);
let top = reduceSelection(data, initialSelection(data), { type: 'ascend' });
check('ascend at root keeps root', top.focusId === 'platform');
top = reduceSelection(data, top, { type: 'step', delta: 1 });
const first = top.selectedId;
top = reduceSelection(data, top, { type: 'step', delta: -1 });
check('step wraps around siblings', first === 'galaxy:fleet' && top.selectedId === 'galaxy:data', `${first} ${top.selectedId}`);
const hover = reduceSelection(data, top, { type: 'hover', id: 'galaxy:dgx' });
check('hover', hover.hoverId === 'galaxy:dgx');
const reducer = createSelectionReducer(data);
check('createSelectionReducer binds data', reducer(initialSelection(data), { type: 'flyTo', id: 'svc:Genesis' }).focusId === 'solar:fleet/core');
const gone = reduceSelection(fixture(), { focusId: 'solar:removed', selectedId: null, hoverId: null, history: [] }, { type: 'select', id: null });
check('a vanished focus falls back to the root', gone.focusId === 'platform');

// ── search ───────────────────────────────────────────────────────────────────
const withAsk = attachCards(data, [card({ id: 'c1', title: 'Restart MicroScheduler?', subject: 'svc:MicroScheduler' })]);
const hits = search(withAsk, 'm');
check('search: asks rank first', hits[0]?.id === 'svc:MicroScheduler', JSON.stringify(hits.slice(0, 3)));
const mesh = search(withAsk, 'me');
check('search: prefix before substring', mesh[0]?.id === 'galaxy:mesh', JSON.stringify(mesh));
const sub = search(data, 'emi');
check('search: substring match', sub.some((h) => h.id === 'agent:demiurge'));
const verb = search(data, 'sleep gpu');
check('search: verb phrase pre-arms the verb', verb[0]?.id === 'gpu:fleet/0' && verb[0]?.verbId === 'sleep', JSON.stringify(verb));
check('search: empty query = []', search(data, '  ').length === 0);
check('search: no match = []', search(data, 'zzzz').length === 0);

// ── verbs ────────────────────────────────────────────────────────────────────
const genesis = data.nodes.find((n) => n.id === 'svc:Genesis')!;
const vf = verbsFor(genesis);
check('verbsFor: one primary', vf.primary?.id === 'restart');
check('verbsFor: at most 2 secondary', vf.secondary.length === 2 && !vf.secondary.some((v) => v.id === 'restart'));
check('verbsFor: always an explore', Boolean(vf.explore.prompt));
check('verbsFor: preferId takes the primary slot', verbsFor(genesis, 'stop').primary?.id === 'stop');
check('primaryAction: primary verb without asks', primaryAction(genesis).kind === 'verb');
const askNode = withAsk.nodes.find((n) => n.id === 'svc:MicroScheduler')!;
check('primaryAction: the ask wins', primaryAction(askNode).kind === 'ask');
check('primaryAction: explore when nothing else', primaryAction(data.nodes.find((n) => n.id === 'galaxy:dgx')!).kind === 'explore');
const explore = data.nodes.find((n) => n.id === 'galaxy:dgx')!;
check('explore uses the node\'s own first prompt', verbsFor({ ...explore, explore: [{ label: 'x', prompt: 'P1' }, { label: 'y', prompt: 'P2' }] }).explore.prompt === 'P1');

// ── glow ─────────────────────────────────────────────────────────────────────
const twoAsks = attachCards(data, [
  card({ id: 'c1', title: 'a', subject: 'model:llama' }),
  card({ id: 'c2', title: 'b', subject: 'svc:Genesis' }),
]);
const glow = glowCounts(twoAsks);
check('glow on the node', glow.get('model:llama') === 1);
check('glow on every ancestor', glow.get('gpu:fleet/0') === 1 && glow.get('solar:fleet/gpu') === 1);
check('glow sums at the shared ancestor', glow.get('galaxy:fleet') === 2 && glow.get('platform') === 2);
check('no glow elsewhere', !glow.has('galaxy:dgx'));

// ── attach: one case per rule ────────────────────────────────────────────────
function card(over: Partial<DeskCard>): DeskCard {
  return { id: 'c', title: '', summary: '', kind: 'decision', urgency: 'normal', options: [], blocking: false, ...over };
}
const index = subjectIndex(data);
const rules: Array<[string, DeskCard, string, string]> = [
  ['explicit subject', card({ subject: 'svc:Genesis' }), 'svc:Genesis', 'explicit'],
  ['explicit virtual-capable subject', card({ subject: 'routine:nightly' }), 'routine:nightly', 'explicit'],
  ['explicit subject that does not resolve falls through', card({ subject: 'svc:Nope', title: 'about Secrets' }), 'svc:Secrets', 'heuristic:service'],
  ['credential → secret', card({ kind: 'credential', secretName: 'PROTON_BRIDGE_PASS' }), 'secret:PROTON_BRIDGE_PASS', 'heuristic:credential'],
  ['escalation: → agent', card({ dedupeKey: 'escalation:x', agent: 'demiurge' }), 'agent:demiurge', 'heuristic:prefix'],
  ['expedition-gate: → atlas', card({ dedupeKey: 'expedition-gate:42' }), 'agent:atlas', 'heuristic:prefix'],
  ['awconnect-pair: → mesh', card({ recipe: 'awconnect-pair:abc' }), 'galaxy:mesh', 'heuristic:prefix'],
  ['pr-review → repo', card({ recipe: 'pr-review' }), 'repo:Aitherium/AitherOS', 'heuristic:prefix'],
  ['wake-* → routine', card({ recipe: 'wake-failed', dedupeKey: 'awrise:wake-failed:nightly-sync:1700' }), 'routine:nightly-sync', 'heuristic:prefix'],
  ['known agent', card({ agent: 'Atlas' }), 'agent:atlas', 'heuristic:agent'],
  ['service in text, longest first', card({ title: 'MicroScheduler queue full' }), 'svc:MicroScheduler', 'heuristic:service'],
  ['service match is whole-word', card({ title: 'regenesisfoo broke' }), 'platform', 'heuristic:platform'],
  ['session', card({ sessionId: 'abc-123' }), 'session:abc-123', 'heuristic:session'],
  ['cwd basename', card({ cwd: 'C:\\AitherOS-Fresh\\' }), 'repo:Aitherium/AitherOS', 'heuristic:cwd'],
  ['host = fleet PC', card({ host: 'fleetpc' }), 'galaxy:fleet', 'heuristic:host'],
  ['host elsewhere → mesh', card({ host: 'laptop' }), 'galaxy:mesh', 'heuristic:host'],
  ['nothing → platform', card({}), 'platform', 'heuristic:platform'],
];
for (const [name, c, id, how] of rules) {
  const got = subjectOf(c, index);
  check(`attach rule: ${name}`, got.id === id && got.how === how, `${got.id} ${got.how}`);
}

// Virtual moons land under the right parent.
const moons = attachCards(data, [
  card({ id: 'k1', kind: 'credential', secretName: 'NEW_KEY' }),
  card({ id: 'k2', sessionId: 's-9' }),
  card({ id: 'k3', recipe: 'wake-failed', dedupeKey: 'awrise:wake-failed:backup:1' }),
  card({ id: 'k4', recipe: 'pr-review' }),
  card({ id: 'k5', dedupeKey: 'escalation:x', agent: 'newbie' }),
]);
const parentOfId = (d: UniverseData, id: string) => d.nodes.find((n) => n.id === id)?.parent;
check('virtual secret under svc:Secrets', parentOfId(moons, 'secret:NEW_KEY') === 'svc:Secrets');
check('virtual session under galaxy:agents (no sessions solar)', parentOfId(moons, 'session:s-9') === 'galaxy:agents');
check('virtual routine under galaxy:fleet', parentOfId(moons, 'routine:backup') === 'galaxy:fleet');
check('virtual repo under galaxy:cloud', parentOfId(moons, 'repo:Aitherium/AitherOS') === 'galaxy:cloud');
check('virtual agent under galaxy:agents', parentOfId(moons, 'agent:newbie') === 'galaxy:agents');
check('virtual moons are flagged', moons.nodes.filter((n) => n.virtual).length === 5);
const noSecrets: UniverseData = { ...data, nodes: data.nodes.filter((n) => n.id !== 'svc:Secrets') };
check(
  'virtual secret falls back to galaxy:data',
  parentOfId(attachCards(noSecrets, [card({ id: 'k1', kind: 'credential', secretName: 'X' })]), 'secret:X') === 'galaxy:data',
);
check('attachCards does not mutate its input', !data.nodes.some((n) => n.asks) && data.nodes.length === fixture().nodes.length);
const ordered = attachCards(data, [card({ id: 'late', subject: 'svc:Genesis' }), card({ id: 'early', subject: 'svc:Genesis' })], ['early', 'late']);
const asks = ordered.nodes.find((n) => n.id === 'svc:Genesis')!.asks!;
check('asks follow the host order and carry rank', asks[0].cardId === 'early' && asks[0].rank === 0 && asks[1].rank === 1);
const cred = attachCards(data, [card({ id: 'k1', kind: 'credential', secretName: 'S', options: [{ key: 'a', label: 'A', recommended: true }] })]);
const credAsk = cred.nodes.find((n) => n.id === 'secret:S')!.asks![0];
check('credential ask carries the secret name and options', credAsk.credential && credAsk.secretName === 'S' && credAsk.options[0].recommended);

finish('universe');
