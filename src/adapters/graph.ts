/**
 * Structural-graph adapters — AitherScope, AitherRegistry, codegraph, AitherGraph.
 *
 * These sources already ship a `{nodes, edges}` shape, so the work here is mapping their
 * vocabulary onto the universe's visual language rather than building a graph.
 */
import type { BeadData, BeadLink, BeadNode, BeadStatus } from '../types';

/**
 * Structural graphs have no timestamps, but radial distance from the cluster core is the
 * engine's strongest encoding — leaving it unused wastes the whole layout. So a numeric
 * metric (lines of code, fan-in, complexity, size) is projected onto a synthetic
 * `createdAt` spanning an arbitrary 180-day window: SMALLER metric → nearer the core.
 *
 * These timestamps are display-only. Never surface them as real dates.
 */
const RADIAL_WINDOW_DAYS = 180;
const RADIAL_EPOCH = Date.UTC(2000, 0, 1);

export function syntheticCreatedAt(value: number, min: number, max: number): string {
  const ratio = max === min ? 0.5 : Math.min(1, Math.max(0, (value - min) / (max - min)));
  return new Date(RADIAL_EPOCH + ratio * RADIAL_WINDOW_DAYS * 86_400_000).toISOString();
}

/** Applies `syntheticCreatedAt` across a set of nodes given a metric accessor. */
function applyRadialMetric<T>(
  items: T[],
  metric: (item: T) => number | undefined,
): (item: T, index: number) => string {
  const values = items.map((item) => metric(item)).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (values.length === 0) return () => new Date(RADIAL_EPOCH).toISOString();
  const min = Math.min(...values);
  const max = Math.max(...values);
  return (item) => {
    const value = metric(item);
    return typeof value === 'number' && Number.isFinite(value)
      ? syntheticCreatedAt(value, min, max)
      : syntheticCreatedAt(min, min, max);
  };
}

/* ─────────────────────────────── AitherScope ─────────────────────────────────
 * `GET /scope/graph/full`, `/scope/graph/unified`, `/scope/graph/subproject/{name}`
 * on Genesis (:8001) — AitherGenesis/routers/scope.py (ScopeNode / ScopeConnection).
 *
 * ⚠️ The two endpoints disagree on the edge key: `/graph/unified` serialises the pydantic
 * `ScopeGraph` (→ `connections`) while `/graph/full` hand-builds a dict (→ `edges`).
 * Both are accepted here; do not "fix" one caller to match the other.
 */

export interface ScopeNodeRecord {
  id: string;
  type?: string;
  name?: string;
  path?: string;
  language?: string;
  status?: string;
  parent?: string | null;
  group?: string | null;
  description?: string;
  tags?: string[];
  metrics?: Record<string, number> | null;
  metadata?: Record<string, unknown>;
}

export interface ScopeConnectionRecord {
  id?: string;
  source?: string;
  target?: string;
  /** `/graph/full` emits the pydantic aliases instead. */
  from?: string;
  to?: string;
  type?: string;
  label?: string;
  isCircular?: boolean;
  weight?: number;
}

export interface ScopeGraphRecord {
  nodes: ScopeNodeRecord[];
  connections?: ScopeConnectionRecord[];
  edges?: ScopeConnectionRecord[];
}

const SCOPE_STATUS: Record<string, BeadStatus> = {
  active: 'open',
  healthy: 'open',
  dead: 'deferred',
  unused: 'deferred',
  orphan: 'deferred',
  deprecated: 'deferred',
  error: 'blocked',
  unhealthy: 'blocked',
  failing: 'blocked',
  modified: 'in_progress',
  wip: 'in_progress',
};

/** Edge types that mean containment rather than reference. */
const CONTAINMENT_TYPES = new Set(['contains', 'parent', 'child', 'member_of', 'declares', 'defines']);

export function fromScopeGraph(
  graph: ScopeGraphRecord,
  {
    clusterBy = 'group',
    radialMetric = (node) => node.metrics?.lines ?? node.metrics?.loc ?? node.metrics?.size,
    assigneeFrom,
  }: {
    clusterBy?: 'group' | 'type' | 'language';
    /** Larger value sits further from the cluster core. Default: lines of code. */
    radialMetric?: (node: ScopeNodeRecord) => number | undefined;
    /** Optional owner extraction — supply this to get ships on a code graph. */
    assigneeFrom?: (node: ScopeNodeRecord) => string | null | undefined;
  } = {},
): BeadData {
  const createdAtFor = applyRadialMetric(graph.nodes, radialMetric);
  const nodes: BeadNode[] = graph.nodes.map((node, index) => {
    const assignee = assigneeFrom?.(node) ?? null;
    const mapped = SCOPE_STATUS[(node.status ?? 'active').toLowerCase()] ?? 'open';
    // An owner only produces a ship on an in_progress node, so claiming ownership
    // implies active work.
    const status: BeadStatus = assignee ? 'in_progress' : mapped;
    return {
      id: node.id,
      title: node.name ?? node.path ?? node.id,
      cluster:
        (clusterBy === 'type'
          ? node.type
          : clusterBy === 'language'
            ? node.language
            : node.group) ?? node.type ?? 'ungrouped',
      status,
      assignee,
      createdAt: createdAtFor(node, index),
      stateStartedAt: null,
      meta: {
        path: node.path,
        type: node.type,
        language: node.language,
        tags: node.tags,
        metrics: node.metrics,
        rawStatus: node.status,
        syntheticCreatedAt: true,
      },
    };
  });

  const known = new Set(nodes.map((node) => node.id));
  const links: BeadLink[] = [];
  const seen = new Set<string>();
  const add = (source: string, target: string, kind: BeadLink['kind']) => {
    if (source === target || !known.has(source) || !known.has(target)) return;
    const key = `${source}→${target}→${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ source, target, kind });
  };

  for (const node of graph.nodes) {
    if (node.parent) add(node.parent, node.id, 'parent-child');
  }
  for (const edge of graph.connections ?? graph.edges ?? []) {
    const source = edge.source ?? edge.from;
    const target = edge.target ?? edge.to;
    if (!source || !target) continue;
    const type = (edge.type ?? '').toLowerCase();
    // A circular dependency IS the problem worth seeing — render it as a blocker.
    const kind: BeadLink['kind'] = edge.isCircular
      ? 'blocks'
      : CONTAINMENT_TYPES.has(type)
        ? 'parent-child'
        : 'related';
    add(source, target, kind);
  }
  return { nodes, links };
}

/* ─────────────────────────── Generic {nodes, edges} ──────────────────────────
 * Covers AitherGraph (:8154), codegraph, the knowledge graph and anything else that
 * emits a node/edge pair under differently-spelled keys.
 */

export interface GenericGraphOptions<N, E> {
  id: (node: N) => string;
  title: (node: N) => string;
  cluster: (node: N) => string;
  status?: (node: N) => BeadStatus;
  assignee?: (node: N) => string | null | undefined;
  /** Return an ISO string, or use `radialMetric` instead to derive one. */
  createdAt?: (node: N) => string | undefined;
  radialMetric?: (node: N) => number | undefined;
  source: (edge: E) => string;
  target: (edge: E) => string;
  kind?: (edge: E) => BeadLink['kind'];
}

export function fromGenericGraph<N, E>(
  graphNodes: N[],
  graphEdges: E[],
  options: GenericGraphOptions<N, E>,
): BeadData {
  const createdAtFor = options.radialMetric
    ? applyRadialMetric(graphNodes, options.radialMetric)
    : null;
  const nodes: BeadNode[] = graphNodes.map((node, index) => {
    const assignee = options.assignee?.(node) ?? null;
    const status = assignee ? 'in_progress' : (options.status?.(node) ?? 'open');
    return {
      id: options.id(node),
      title: options.title(node),
      cluster: options.cluster(node),
      status,
      assignee,
      createdAt:
        options.createdAt?.(node) ??
        createdAtFor?.(node, index) ??
        new Date(RADIAL_EPOCH).toISOString(),
      stateStartedAt: null,
    };
  });

  const known = new Set(nodes.map((node) => node.id));
  const links: BeadLink[] = [];
  for (const edge of graphEdges) {
    const source = options.source(edge);
    const target = options.target(edge);
    if (source === target || !known.has(source) || !known.has(target)) continue;
    links.push({ source, target, kind: options.kind?.(edge) ?? 'related' });
  }
  return { nodes, links };
}

/* ────────────────────────────── AitherRegistry ───────────────────────────────
 * A registry is a flat catalogue, not a graph. The only relationships available are the
 * ones the entries declare (`depends_on`, `provides`/`requires`), so a registry universe
 * is mostly constellations-by-kind with sparse dependency arcs.
 */

export interface RegistryEntryRecord {
  id?: string;
  name: string;
  version?: string;
  kind?: string;
  category?: string;
  status?: string;
  depends_on?: string[];
  requires?: string[];
  provides?: string[];
  updated_at?: string;
  created_at?: string;
  size?: number;
  metadata?: Record<string, unknown>;
}

const REGISTRY_STATUS: Record<string, BeadStatus> = {
  published: 'open',
  active: 'open',
  available: 'open',
  draft: 'deferred',
  deprecated: 'deferred',
  yanked: 'deferred',
  archived: 'done',
  broken: 'blocked',
  failed: 'blocked',
  building: 'in_progress',
  publishing: 'in_progress',
};

export function fromRegistry(entries: RegistryEntryRecord[]): BeadData {
  const idOf = (entry: RegistryEntryRecord) => entry.id ?? entry.name;
  const createdAtFor = applyRadialMetric(entries, (entry) => entry.size);
  const nodes: BeadNode[] = entries.map((entry, index) => ({
    id: idOf(entry),
    title: entry.version ? `${entry.name} ${entry.version}` : entry.name,
    cluster: entry.kind ?? entry.category ?? 'uncategorised',
    status: REGISTRY_STATUS[(entry.status ?? 'active').toLowerCase()] ?? 'open',
    assignee: null,
    // A real publish timestamp beats the synthetic size-based one when present.
    createdAt: entry.created_at ?? entry.updated_at ?? createdAtFor(entry, index),
    stateStartedAt: null,
    meta: { version: entry.version, kind: entry.kind, rawStatus: entry.status, ...entry.metadata },
  }));

  const known = new Set(nodes.map((node) => node.id));
  const links: BeadLink[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    for (const dependency of [...(entry.depends_on ?? []), ...(entry.requires ?? [])]) {
      const key = `${dependency}→${idOf(entry)}`;
      if (!known.has(dependency) || dependency === idOf(entry) || seen.has(key)) continue;
      seen.add(key);
      links.push({ source: dependency, target: idOf(entry), kind: 'parent-child' });
    }
  }
  return { nodes, links };
}
