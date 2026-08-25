/**
 * Platform adapters — the agent constellation and the service fleet.
 */
import type { BeadData, BeadLink, BeadNode, BeadStatus } from '../types';
import { syntheticCreatedAt } from './graph';

/* ────────────────────────── Agent constellation ──────────────────────────────
 * `GET /api/constellation` in AitherVeil, which loads AitherOS/config/constellation.yaml
 * (30s cache). Rings 0–5: Genesis → Aither → named agents → elementals → knights → sins.
 *
 * The config has no timestamps, so RING drives radial distance instead: ring 0 sits at the
 * cluster core and the sins orbit furthest out. That is exactly the intended reading of the
 * hierarchy, so the synthetic-timestamp trick lands rather than lies.
 */

export interface ConstellationAgentRecord {
  id: string;
  name: string;
  title?: string;
  epithet?: string;
  ring?: number;
  category?: string;
  /** active | idle | dreaming */
  status?: string;
  mood?: string;
  description?: string;
  connections?: string[];
  parentAgent?: string;
  twinOf?: string;
  port?: number;
  href?: string;
}

export interface ConstellationLinkRecord {
  from: string;
  to: string;
  /** parent | elemental-bond | knight-bond | sin-bond | twin | collaborates | orchestrates */
  type?: string;
  label?: string;
  strength?: number;
}

export interface ConstellationRecord {
  agents: ConstellationAgentRecord[];
  links?: ConstellationLinkRecord[];
  categories?: Record<string, { label?: string; color?: string; description?: string }>;
}

const LINEAGE_TYPES = new Set(['parent', 'elemental-bond', 'knight-bond', 'sin-bond']);

export function fromConstellation(
  constellation: ConstellationRecord,
  { maxRing = 5 }: { maxRing?: number } = {},
): BeadData {
  const agents = constellation.agents ?? [];
  const nodes: BeadNode[] = agents.map((agent) => {
    const raw = (agent.status ?? 'idle').toLowerCase();
    // An active agent is its own owner, so it gets a ship orbiting it — the roster reads
    // at a glance as "who is awake right now".
    const status: BeadStatus = raw === 'active' ? 'in_progress' : raw === 'dreaming' ? 'deferred' : 'open';
    return {
      id: agent.id,
      title: agent.title ? `${agent.name} — ${agent.title}` : agent.name,
      cluster: agent.category ?? 'agent',
      status,
      assignee: status === 'in_progress' ? agent.name : null,
      createdAt: syntheticCreatedAt(agent.ring ?? 2, 0, maxRing),
      stateStartedAt: null,
      href: agent.href,
      meta: {
        ring: agent.ring,
        epithet: agent.epithet,
        mood: agent.mood,
        port: agent.port,
        category: agent.category,
        syntheticCreatedAt: true,
      },
    };
  });

  const known = new Set(nodes.map((node) => node.id));
  const links: BeadLink[] = [];
  const seen = new Set<string>();
  const add = (source: string, target: string, kind: BeadLink['kind']) => {
    if (source === target || !known.has(source) || !known.has(target)) return;
    // Lineage is directional; collaboration is not — dedupe undirected pairs both ways.
    const key = kind === 'parent-child' ? `${source}→${target}` : [source, target].sort().join('↔');
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ source, target, kind });
  };

  if (constellation.links && constellation.links.length > 0) {
    for (const link of constellation.links) {
      const type = (link.type ?? '').toLowerCase();
      add(link.from, link.to, LINEAGE_TYPES.has(type) ? 'parent-child' : 'related');
    }
  } else {
    // Fall back to the per-agent fields when the top-level link table is absent.
    for (const agent of agents) {
      if (agent.parentAgent) add(agent.parentAgent, agent.id, 'parent-child');
      for (const other of agent.connections ?? []) add(agent.id, other, 'related');
    }
  }
  return { nodes, links };
}

/* ──────────────────────────────── Fleet ──────────────────────────────────────
 * AitherOS/config/services.yaml (`services:` map) plus, optionally, live health.
 *
 * `layer` drives radial distance — layer 0 infrastructure sits at the core and the
 * high-layer application services orbit the rim, which is how the stack is meant to read.
 */

export interface FleetServiceRecord {
  name: string;
  port?: number;
  type?: string;
  group?: string;
  layer?: number;
  description?: string;
  depends_on?: string[];
  docker?: { container?: string; image?: string };
}

/** Live health, keyed by service name or container name. */
export type FleetHealth = Record<string, string | undefined>;

const FLEET_STATUS: Record<string, BeadStatus> = {
  healthy: 'open',
  running: 'open',
  up: 'open',
  unhealthy: 'blocked',
  exited: 'blocked',
  dead: 'blocked',
  error: 'blocked',
  starting: 'in_progress',
  restarting: 'in_progress',
  disabled: 'deferred',
  stopped: 'deferred',
};

export function fromFleet(
  services: FleetServiceRecord[],
  {
    health = {},
    maxLayer = 10,
  }: { health?: FleetHealth; maxLayer?: number } = {},
): BeadData {
  const statusOf = (service: FleetServiceRecord): BeadStatus => {
    const raw = (
      health[service.name] ??
      (service.docker?.container ? health[service.docker.container] : undefined) ??
      ''
    ).toLowerCase();
    if (!raw) return 'open';
    // Docker status strings are sentences ("Up 13 hours (healthy)"), not enums.
    if (raw.includes('unhealthy')) return 'blocked';
    if (raw.includes('restarting') || raw.includes('starting')) return 'in_progress';
    if (raw.includes('exited') || raw.includes('dead')) return 'blocked';
    if (raw.includes('healthy') || raw.startsWith('up')) return 'open';
    return FLEET_STATUS[raw] ?? 'open';
  };

  const nodes: BeadNode[] = services.map((service) => ({
    id: service.name,
    title: service.description
      ? `${service.name} — ${service.description.split('\n')[0].slice(0, 120)}`
      : service.name,
    cluster: service.group ?? service.type ?? 'ungrouped',
    status: statusOf(service),
    assignee: null,
    createdAt: syntheticCreatedAt(service.layer ?? 5, 0, maxLayer),
    stateStartedAt: null,
    meta: {
      port: service.port,
      layer: service.layer,
      type: service.type,
      container: service.docker?.container,
      health: health[service.name] ?? null,
      syntheticCreatedAt: true,
    },
  }));

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const links: BeadLink[] = [];
  for (const service of services) {
    for (const dependency of service.depends_on ?? []) {
      if (!byId.has(dependency) || dependency === service.name) continue;
      // A dependency is normally just the shape of the stack (solid). It only becomes a
      // BLOCKER — the orange dashed link — when the thing depended on is actually down.
      const upstream = byId.get(dependency)!;
      links.push({
        source: dependency,
        target: service.name,
        kind: upstream.status === 'blocked' ? 'blocks' : 'parent-child',
      });
    }
  }
  return { nodes, links };
}

/** Convenience: turn the `services:` map from services.yaml into the array shape. */
export function fleetServicesFromConfig(
  servicesMap: Record<string, Omit<FleetServiceRecord, 'name'>>,
): FleetServiceRecord[] {
  return Object.entries(servicesMap).map(([name, service]) => ({ name, ...service }));
}
