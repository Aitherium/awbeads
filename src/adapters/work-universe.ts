/**
 * Work-universe adapter — the agents' REAL work, from Genesis `GET /beadspace/graph`
 * (Veil: `/api/beadspace/graph`, built by `AitherOS/lib/beadspace/adapter.py`).
 *
 * The server already speaks this package's contract — Atlas PM items, TaskHub tasks,
 * agent-salon threads and agent-written beads, one constellation per agent — so this
 * adapter only VALIDATES: a row the engine cannot place is dropped here instead of
 * throwing inside d3-force, and `source` rides in `meta` for the tooltip.
 *
 * Constellations are agents, which are nominal, not ordinal: no `clusterOrder` needed,
 * but `WORK_UNIVERSE_CLUSTER_ORDER` pins the PM cycle's cast so their colours never
 * reshuffle as the backlog grows.
 */
import type { BeadData, BeadLink, BeadLinkKind, BeadNode, BeadStatus } from '../types';

export interface WorkUniverseRecord {
  nodes?: unknown[];
  links?: unknown[];
  meta?: Record<string, unknown>;
}

/** Atlas triages, Lyra researches, Demiurge builds, Hydra reviews (AtlasPM.py). */
export const WORK_UNIVERSE_CLUSTER_ORDER = ['atlas', 'lyra', 'demiurge', 'hydra'];

const STATUSES: ReadonlySet<string> = new Set(['open', 'in_progress', 'blocked', 'deferred', 'done']);
const KINDS: ReadonlySet<string> = new Set(['parent-child', 'blocks', 'related']);

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function fromWorkUniverse(payload: WorkUniverseRecord | null | undefined): BeadData {
  const rawNodes = Array.isArray(payload?.nodes) ? payload!.nodes : [];
  const nodes: BeadNode[] = [];
  const seen = new Set<string>();
  for (const raw of rawNodes) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const id = str(r.id);
    const title = str(r.title);
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    const created = str(r.createdAt);
    const started = str(r.stateStartedAt);
    // Beads' own tracker says `closed`; this package says `done`.
    const status = str(r.status) === 'closed' ? 'done' : str(r.status);
    const node: BeadNode = {
      id,
      title,
      cluster: str(r.cluster) || 'unassigned',
      status: (STATUSES.has(status) ? status : 'open') as BeadStatus,
      assignee: str(r.assignee) || null,
      createdAt: Number.isFinite(Date.parse(created)) ? created : new Date(0).toISOString(),
      stateStartedAt: Number.isFinite(Date.parse(started)) ? started : null,
      meta: { source: str(r.source) },
    };
    const href = str(r.href);
    if (/^https:\/\//.test(href)) node.href = href;
    nodes.push(node);
  }
  const links: BeadLink[] = [];
  for (const raw of Array.isArray(payload?.links) ? payload!.links : []) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const source = str(r.source);
    const target = str(r.target);
    const kind = str(r.kind);
    if (seen.has(source) && seen.has(target) && source !== target && KINDS.has(kind)) {
      links.push({ source, target, kind: kind as BeadLinkKind });
    }
  }
  return { nodes, links };
}
