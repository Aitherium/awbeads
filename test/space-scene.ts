/**
 * The 3D scene buffers (pure), the gesture rule, the palette rules, and the selection
 * panel's credential / confirm contracts in jsdom.
 *
 *   npx esbuild test/space-scene.ts --bundle --platform=node --format=esm --outfile=test/space-scene.mjs --external:jsdom
 *   node test/space-scene.mjs
 */
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';

import { zoomGestureAllowed } from '../src/core/bead-space';
import { spaceGestureAllowed } from '../src/space/gesture';
import { PALETTE, healthColor, isHollow } from '../src/space/palette';
import { auditLine, auditSentence, auditSummaryOf, lensOf, lensSentence } from '../src/space/panel-text';
import { LENS_DIM, askGlow, buildInstances, positions3d } from '../src/space/scene';
import { attachCards, visibleAt } from '../src/universe';
import type { DeskCard } from '../src/types';
import { bigUniverse, check, finish, fixture } from './universe-fixture';

const data = attachCards(fixture(), [
  { id: 'c1', title: 'Store the key', summary: '', kind: 'credential', urgency: 'high', secretName: 'K', options: [], blocking: true },
  { id: 'c2', title: 'Restart?', summary: '', kind: 'decision', urgency: 'normal', subject: 'svc:Genesis', options: [], blocking: false },
] as DeskCard[]);
const positions = positions3d(data);
const glow = askGlow(data);

for (const focus of ['platform', 'galaxy:fleet', 'solar:fleet/core', 'gpu:fleet/0']) {
  const v = visibleAt(data, focus)!;
  const inst = buildInstances(v, positions, { data, glow });
  const expected = v.nodes.length + v.ghosts.length;
  check(`buildInstances count = visible count @${focus}`, inst.count === expected, `${inst.count} vs ${expected}`);
  check(`buffers sized @${focus}`, inst.colors.length === expected * 3 && inst.scales.length === expected && inst.centers.length === expected * 3);
  check(`ghosts first @${focus}`, inst.ghost.slice(0, v.ghosts.length).every((x) => x === 1) && inst.ghost.slice(v.ghosts.length).every((x) => x === 0));
  check(`scales positive @${focus}`, [...inst.scales].every((s) => s > 0));
}

const core = buildInstances(visibleAt(data, 'solar:fleet/core')!, positions, { data, glow });
check('beacon on the node with an ask', core.glowIds.includes('svc:Genesis'));
check('beacon on the ancestor of a deep ask (secret under Secrets)', core.glowIds.includes('svc:Secrets'));
const secretsBeacon = core.beacons.find((b) => b.id === 'svc:Secrets');
check('urgent ask → forge beacon', secretsBeacon?.urgent === true);
check('normal ask → gold beacon', core.beacons.find((b) => b.id === 'svc:Genesis')?.urgent === false);
check('link segments: 1 solid traffic link @core', core.linkPositions.length === 6 && core.trafficPositions.length === 6);
const gpu = buildInstances(visibleAt(data, 'gpu:fleet/0')!, positions, { data, glow });
const llama = gpu.ids.indexOf('model:llama');
check('unknown health is hollow', gpu.hollow[llama] === 1);
const fleet = buildInstances(visibleAt(data, 'galaxy:fleet')!, positions, { data, glow });
check('dashed link for kind=related', fleet.dashedLinkPositions.length === 0 || fleet.dashedLinkPositions.length % 6 === 0);

// ── profile lens (pure) ──────────────────────────────────────────────────────
{
  const v = visibleAt(data, 'solar:fleet/core')!;
  const someSvc = v.nodes.find((n) => n.id.startsWith('svc:'))!;
  const lens = lensOf(data, 'business');
  check('lens dims every svc outside the tier (fixture has no profiles)', Boolean(lens && lens.dimIds.has(someSvc.id)));
  check('lens none dims nothing', lensOf(data, 'none') === null);
  check('lens without tier_ram sums the beads (services)', lens?.noun === 'services');
  // The apply set: galaxy:fleet tier_ram counts every container the sidecar keeps,
  // including the ones no services.yaml bead carries (Postgres, the tunnel, DNS).
  const withApply = {
    ...data,
    nodes: data.nodes.map((n) => (n.id === 'galaxy:fleet'
      ? { ...n, meta: { ...(n.meta ?? {}), fleet_ram_mb: 22937.6,
        tier_ram: { business: { mb: 16793.6, measured: 40, containers: 43 } } } }
      : n)),
  };
  const applied = lensOf(withApply, 'business');
  check('lens prefers the apply-set sum over the beads', applied?.ramMb === 16793.6
    && applied?.fleetMb === 22937.6 && applied?.count === 43 && applied?.noun === 'containers');
  check('lens sentence names containers and the unmeasured', lensSentence(applied!)
    === 'business 16.4 GB of 22.4 GB · 43 containers (40 measured)');
  check('a tier tier_ram lacks falls back to the beads', lensOf(withApply, 'platform')?.noun === 'services');
  check('lens still dims by membership with tier_ram', Boolean(applied && applied.dimIds.has(someSvc.id)));
  const lit = buildInstances(v, positions, { data, glow });
  const dimmed = buildInstances(v, positions, { data, glow, dimIds: new Set([someSvc.id]) });
  const at = lit.ids.indexOf(someSvc.id);
  check('lens dims colour, not status', Math.abs(dimmed.colors[at * 3] - lit.colors[at * 3] * LENS_DIM) < 1e-6
    && dimmed.hollow[at] === lit.hollow[at]);
}

const big = bigUniverse(300);
const bigInst = buildInstances(visibleAt(big, 'galaxy:fleet')!, positions3d(big), { data: big });
check('300-node universe builds', bigInst.count > 1);

// ── palette ──────────────────────────────────────────────────────────────────
check('unknown is never green', healthColor('unknown') !== PALETTE.healthy && isHollow('unknown'));
check('ok is healthy green', healthColor('ok') === PALETTE.healthy && !isHollow('ok'));
check('down is danger', healthColor('down') === PALETTE.danger);

// ── gesture parity with the 2D engine ────────────────────────────────────────
const gestures = [
  { type: 'wheel' },
  { type: 'wheel', ctrlKey: true },
  { type: 'wheel', metaKey: true },
  { type: 'mousedown', button: 0 },
  { type: 'mousedown', button: 2 },
  { type: 'mousedown', button: 0, ctrlKey: true },
  { type: 'touchstart' },
];
for (const ev of gestures) {
  check(`gesture parity ${JSON.stringify(ev)}`, spaceGestureAllowed(ev) === zoomGestureAllowed(ev));
}

// ── selection panel in jsdom ─────────────────────────────────────────────────
async function panelChecks(): Promise<void> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
  const g = globalThis as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.HTMLElement = dom.window.HTMLElement;
  g.Node = dom.window.Node;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  const { createRoot } = await import('react-dom/client');
  const { SelectionPanel } = await import('../src/space/SelectionPanel');

  const secretNode = data.nodes.find((n) => n.id === 'secret:K')!;
  const container = dom.window.document.getElementById('root')!;
  const root = createRoot(container);
  const received: string[] = [];
  let reply: { ok: boolean; error?: string } = { ok: false, error: 'card not closed' };
  await act(async () => {
    root.render(createElement(SelectionPanel, {
      node: secretNode,
      onCredential: async (_id: string, value: string) => {
        received.push(value);
        return reply;
      },
    }));
  });
  const input = () => container.querySelector('input[type="password"]') as HTMLInputElement;
  const storeBtn = () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Store in vault')!;
  check('credential ask renders a masked input', Boolean(input()));
  input().value = 'hunter2';
  await act(async () => {
    storeBtn().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  check('onCredential got the value once', received.length === 1 && received[0] === 'hunter2');
  check('input cleared after store', input().value === '');
  check('non-ok reply shows the error, not success', container.textContent!.includes('card not closed') && !container.textContent!.includes('stored · card closed'));

  reply = { ok: true };
  input().value = 'hunter3';
  await act(async () => {
    storeBtn().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  check('ok:true shows stored · card closed', container.textContent!.includes('stored · card closed'));

  // A truthy-but-not-true ok is NOT success.
  await act(async () => {
    root.render(createElement(SelectionPanel, {
      key: 'again',
      node: secretNode,
      onCredential: async () => ({ ok: 'yes' as unknown as boolean }),
    }));
  });
  input().value = 'x';
  await act(async () => {
    storeBtn().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  check('only ok === true counts', !container.textContent!.includes('stored · card closed'));

  // Danger verbs: first click arms, second sends confirmed:true.
  const genesis = data.nodes.find((n) => n.id === 'svc:Genesis')!;
  const calls: Array<{ verb: string; confirmed: boolean }> = [];
  await act(async () => {
    root.render(createElement(SelectionPanel, {
      key: 'verbs',
      node: { ...genesis, asks: undefined },
      onVerb: async (_n: unknown, verb: { id: string }, opts: { confirmed: boolean }) => {
        calls.push({ verb: verb.id, confirmed: opts.confirmed });
        return { ok: true };
      },
    }));
  });
  const restart = () => [...container.querySelectorAll('button')].find((b) => /restart/i.test(b.textContent ?? ''))!;
  await act(async () => {
    restart().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  check('danger verb: first click only arms', calls.length === 0 && restart().getAttribute('data-armed') === 'true');
  await act(async () => {
    restart().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  check('danger verb: second click sends confirmed:true', calls.length === 1 && calls[0].verb === 'restart' && calls[0].confirmed);
  const verbButtons = container.querySelectorAll('[data-block="verbs"] button');
  check('at most 1 primary + 2 secondary verbs', verbButtons.length === 3, String(verbButtons.length));

  // An ask owns the one big button: the verbs drop into its row of chips, and a healthy
  // state line (which would contradict "restart it?") is not shown.
  await act(async () => {
    root.render(createElement(SelectionPanel, {
      key: 'asking',
      node: {
        ...genesis,
        health: { state: 'ok', reason: 'Watch: online' },
        asks: [{ cardId: 'c9', title: 'Restart the watchdog?', urgency: 'normal', credential: false, how: 'explicit',
          options: [{ key: 'y', label: 'Restart it', recommended: true }, { key: 'n', label: 'Leave it' }] }],
      },
      onVerb: async () => ({ ok: true }),
      onAnswer: async () => ({ ok: true }),
    }));
  });
  const askBlock = container.querySelector('[data-block="ask"]');
  const bigs = [...container.querySelectorAll('button')].filter((b) => (b as HTMLElement).style.width === '100%');
  check('with an ask: one big button, the recommended answer', bigs.length === 1 && bigs[0].textContent === 'Restart it',
    bigs.map((b) => b.textContent).join('|'));
  check('with an ask: the verbs sit in the ask block as chips',
    Boolean(askBlock && askBlock.querySelector('[data-block="verbs"] button')));
  check('with an ask: a healthy state line is not shown', !container.querySelector('[data-state]'));
  await act(async () => {
    root.render(createElement(SelectionPanel, {
      key: 'healthy', node: { ...genesis, asks: undefined, health: { state: 'ok', reason: 'Watch: online' } },
    }));
  });
  check('state line reads "Healthy · Watch online"',
    (container.querySelector('[data-state]')?.textContent ?? '') === 'Healthy · Watch online',
    container.querySelector('[data-state]')?.textContent ?? '');
  // ── "What it is doing" + profile chips ─────────────────────────────────────
  const pv = (id: string, label: string) => ({ id, label, danger: 'none' as const, transport: 'profile' as const });
  const veil = {
    ...genesis, id: 'svc:Veil', title: 'Veil', asks: undefined,
    health: { state: 'ok' as const, reason: 'Watch: online' },
    meta: { role: 'The web OS', criticality: 'important', profiles: ['platform', 'critical', 'full'],
      kept_because: 'Veil requires: room', mem_mb: 900, cpu_pct: 4.2, dependents: 4 },
    verbs: [{ id: 'services-sick', label: 'Sick services', danger: 'none' as const, transport: 'fleet' as const, primary: true },
      pv('profile-add:business', 'Add to business'), pv('reclassify-edge:Veil:Room', 'Make Veil -> Room soft')],
  };
  const pcalls: string[] = [];
  await act(async () => {
    root.render(createElement(SelectionPanel, {
      key: 'doing', node: veil,
      onVerb: async (_n: unknown, verb: { id: string }) => {
        pcalls.push(verb.id);
        return { ok: true, pr_url: 'https://github.com/Aitherium/AitherOS/pull/9' };
      },
    }));
  });
  const doing = container.querySelector('[data-block="doing"]');
  check('doing block renders role, state, CPU, RAM and dependents',
    (doing?.querySelector('[data-doing-line]')?.textContent ?? '') === 'The web OS · Healthy · CPU 4.2% · RAM 900 MB · 4 dependents',
    doing?.querySelector('[data-doing-line]')?.textContent ?? '');
  check('doing line never prints an unmeasured disk', !(doing?.textContent ?? '').includes('disk'));
  check('profile verbs are not in the verb row',
    ![...container.querySelectorAll('[data-block="verbs"] button')].some((b) => /business|soft/.test(b.textContent ?? '')));
  check('in-tier chips are marked', container.querySelectorAll('[data-profiles] [data-in="true"]').length === 3);
  const addBtn = container.querySelector('[data-profiles] button[data-tier="business"]') as HTMLElement | null;
  check('a tier it can join is a button', Boolean(addBtn) && (addBtn?.textContent ?? '') === '+ business');
  await act(async () => {
    addBtn!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  check('the chip sends the profile verb', pcalls.join(',') === 'profile-add:business', pcalls.join(','));
  check('the PR link is shown', Boolean(container.querySelector('[data-reply-pr]')));
  check('kept because is shown', (container.querySelector('[data-kept]')?.textContent ?? '') === 'kept because Veil requires: room');
  check('panel stays within five blocks', container.querySelectorAll('[data-node] > [data-block]').length <= 5,
    String(container.querySelectorAll('[data-node] > [data-block]').length));

  // Core: a fixed label, no chip buttons, even if a (forged) profile verb rides along.
  await act(async () => {
    root.render(createElement(SelectionPanel, {
      key: 'core', node: { ...veil, id: 'svc:Chronicle', title: 'Chronicle',
        meta: { criticality: 'core', profiles: ['business', 'platform', 'critical', 'full'], kept_because: 'core: never stopped' },
        verbs: [veil.verbs[0], pv('profile-remove:business', 'Remove from business')] },
      onVerb: async () => ({ ok: true }),
    }));
  });
  check('core shows "core: never stopped"', (container.querySelector('[data-core]')?.textContent ?? '') === 'core: never stopped');
  check('core has no profile buttons', container.querySelectorAll('[data-profiles] button').length === 0);

  // An inference status verdict renders its lane table.
  await act(async () => {
    root.render(createElement(SelectionPanel, {
      key: 'lanes', node: { ...genesis, id: 'galaxy:dgx', title: 'DGX', asks: undefined, meta: {},
        verbs: [{ id: 'inference-status', label: 'Inference status', danger: 'none' as const, transport: 'fleet' as const, primary: true }] },
      onVerb: async () => ({ ok: true, result: { mode: 'dgx', lanes: [
        { lane: 'orchestrator', verdict: 'PASS', served_by: 'spark', latency_ms: 812 },
        { lane: 'deepseek-v4-flash-pool', verdict: 'FAIL', served_by: '', latency_ms: null }] } }),
    }));
  });
  const statusBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Inference status')!;
  await act(async () => {
    statusBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  const rowsEls = container.querySelectorAll('[data-lanes] tr');
  check('lane table has one row per lane', rowsEls.length === 2, String(rowsEls.length));
  check('lane row carries verdict and served_by', (rowsEls[0]?.textContent ?? '').includes('PASS')
    && (rowsEls[0]?.textContent ?? '').includes('spark'));

  // The audit block: the verdict, what a trim frees, the use, and the evidence line.
  await act(async () => {
    root.render(createElement(SelectionPanel, {
      key: 'audit', node: { ...veil, id: 'svc:Iris', title: 'Iris', asks: undefined,
        meta: { verdict: 'trim-candidate', frees_mb: 99, requests: 6, log_hours: 13.4, mem_mb: 99,
          evidence: 'not in business: a business trim stops it' },
        verbs: [{ id: 'unit-park:aither-iris', label: 'Park', danger: 'confirm' as const, transport: 'unit' as const, primary: true }] },
      onVerb: async () => ({ ok: true }),
    }));
  });
  const auditEl = container.querySelector('[data-block="audit"]');
  check('audit block shows the verdict, frees and use',
    (auditEl?.textContent ?? '').includes('Trim candidate · frees 99 MB · 6 requests in 13 h'), auditEl?.textContent ?? '');
  check('audit block shows the evidence', (container.querySelector('[data-evidence]')?.textContent ?? '')
    === 'not in business: a business trim stops it');
  check('no verdict, no audit block', auditLine({ ...veil, meta: {} }) === '');
  const summary = auditSummaryOf({ ...data, nodes: data.nodes.map((n) => (n.id === 'galaxy:fleet'
    ? { ...n, meta: { audit: { running: 53, ram_mb: 22937.6, frees_mb: 320, by_verdict: { waste: 1 },
      generated_at: '2026-10-16T09:00:00Z', logs_scanned: true } } } : n)) });
  check('audit sentence: running, RAM, trim frees, age',
    auditSentence(summary!, Date.parse('2026-10-16T09:12:00Z'))
      === '53 running · 22.4 GB · trim frees 320 MB · measured 12 min ago', summary ? auditSentence(summary) : 'null');
  check('no audit on the fleet = null summary', auditSummaryOf(data) === null);

  // The profile lens: sums measured RAM and dims outsiders.
  const { ProfileLens } = await import('../src/space/Hud');
  const lensData = {
    ...data,
    nodes: [
      ...data.nodes,
      { ...veil, id: 'svc:A', meta: { profiles: ['business', 'full'], mem_mb: 1024 } },
      { ...veil, id: 'svc:B', meta: { profiles: ['full'], mem_mb: 2048 } },
      { ...veil, id: 'svc:C', meta: { profiles: ['business', 'full'] } },
    ],
  };
  const seenTier: string[] = [];
  await act(async () => {
    root.render(createElement(ProfileLens, { key: 'lens', data: lensData, tier: 'business', onTier: (t: string) => seenTier.push(t) }));
  });
  const sum = container.querySelector('[data-lens-sum]')?.textContent ?? '';
  check('lens sums the tier against the fleet, unmeasured counted honestly',
    sum === 'business 1.0 GB of 3.0 GB · 2 services (1 measured)', sum);
  const noneBtn = [...container.querySelectorAll('[data-lens] button')].find((b) => b.textContent === 'none')!;
  await act(async () => {
    noneBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  check('lens reports the chosen tier', seenTier.join(',') === 'none');

  await act(async () => root.unmount());
  // pretendToBeVisual runs a rAF timer that would keep node alive forever.
  dom.window.close();
}

await panelChecks();
finish('space-scene');
