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
import { askGlow, buildInstances, positions3d } from '../src/space/scene';
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
  await act(async () => root.unmount());
  // pretendToBeVisual runs a rAF timer that would keep node alive forever.
  dom.window.close();
}

await panelChecks();
finish('space-scene');
