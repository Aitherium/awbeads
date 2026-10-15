/** A small universe shaped like the U1 contract, shared by the universe tests. */
import type { BeadLevel, UniverseData, UniverseLink, UniverseNode } from '../src/types';

export function node(
  id: string,
  level: BeadLevel,
  parent: string | null,
  extra: Partial<UniverseNode> = {},
): UniverseNode {
  return {
    id,
    title: extra.title ?? id.slice(id.indexOf(':') + 1),
    level,
    parent,
    cluster: parent ?? 'platform',
    status: 'open',
    createdAt: '2026-10-15T00:00:00Z',
    health: { state: 'ok' },
    ...extra,
  };
}

export function fixture(): UniverseData {
  const nodes: UniverseNode[] = [
    node('platform', 'universe', null, { title: 'Platform' }),
    node('galaxy:fleet', 'galaxy', 'platform', { title: 'Fleet', meta: { host_name: 'FLEETPC' } }),
    node('galaxy:dgx', 'galaxy', 'platform', { title: 'DGX' }),
    node('galaxy:mesh', 'galaxy', 'platform', { title: 'Mesh' }),
    node('galaxy:cloud', 'galaxy', 'platform', { title: 'Cloud' }),
    node('galaxy:agents', 'galaxy', 'platform', { title: 'Agents' }),
    node('galaxy:data', 'galaxy', 'platform', { title: 'Data' }),
    node('solar:fleet/core', 'solar', 'galaxy:fleet', { title: 'Core' }),
    node('solar:fleet/gpu', 'solar', 'galaxy:fleet', { title: 'GPU' }),
    node('svc:Genesis', 'system', 'solar:fleet/core', {
      title: 'Genesis',
      verbs: [
        { id: 'restart', label: 'Restart', danger: 'confirm', transport: 'fleet', primary: true },
        { id: 'logs', label: 'Logs', danger: 'none', transport: 'open' },
        { id: 'health', label: 'Health', danger: 'none', transport: 'fleet' },
        { id: 'stop', label: 'Stop', danger: 'confirm', transport: 'fleet' },
      ],
    }),
    node('svc:Secrets', 'system', 'solar:fleet/core', { title: 'Secrets' }),
    node('svc:MicroScheduler', 'system', 'solar:fleet/core', { title: 'MicroScheduler', health: { state: 'degraded', reason: 'queue backed up' } }),
    node('gpu:fleet/0', 'system', 'solar:fleet/gpu', {
      title: 'GPU 0',
      verbs: [{ id: 'sleep', label: 'Sleep', danger: 'none', transport: 'fleet' }],
    }),
    node('model:llama', 'moon', 'gpu:fleet/0', { title: 'Llama', health: { state: 'unknown' } }),
    node('agent:atlas', 'system', 'galaxy:agents', { title: 'Atlas' }),
    node('agent:demiurge', 'system', 'galaxy:agents', { title: 'Demiurge' }),
  ];
  const links: UniverseLink[] = [
    { source: 'svc:Genesis', target: 'svc:MicroScheduler', kind: 'parent-child', rel: 'traffic' },
    { source: 'svc:Genesis', target: 'gpu:fleet/0', kind: 'related', rel: 'depends' },
    { source: 'agent:atlas', target: 'svc:Genesis', kind: 'parent-child', rel: 'traffic' },
  ];
  return {
    universe_version: 1,
    generated_at: '2026-10-15T00:00:00Z',
    etag: 'x',
    nodes,
    links,
    meta: { sources: {}, counts: {}, ttl_s: 15 },
  };
}

/** A synthetic universe of `n` nodes: 6 galaxies, solars, systems, moons. */
export function bigUniverse(n: number): UniverseData {
  const nodes: UniverseNode[] = [node('platform', 'universe', null)];
  const galaxies = ['fleet', 'dgx', 'mesh', 'cloud', 'agents', 'data'];
  for (const g of galaxies) nodes.push(node(`galaxy:${g}`, 'galaxy', 'platform'));
  let i = 0;
  while (nodes.length < n) {
    const g = galaxies[i % galaxies.length];
    const solar = `solar:${g}/s${i % 5}`;
    if (!nodes.some((x) => x.id === solar)) nodes.push(node(solar, 'solar', `galaxy:${g}`));
    nodes.push(node(`svc:n${i}`, 'system', solar));
    i += 1;
  }
  return { universe_version: 1, generated_at: '', etag: '', nodes: nodes.slice(0, n), links: [], meta: {} };
}

let failed = 0;
let passed = 0;

export function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}

export function finish(label: string): void {
  if (failed) {
    console.error(`${label}: ${failed} failed, ${passed} passed`);
    process.exit(1);
  }
  console.log(`${label}: ${passed} checks passed`);
  // React's scheduler holds MessageChannel ports open in node; exit explicitly.
  process.exit(0);
}
