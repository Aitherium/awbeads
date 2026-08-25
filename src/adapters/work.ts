/**
 * Work-graph adapters — the universe's native shape: tasks as planets, dependencies as
 * flight paths, the agent holding an item as the ship orbiting it.
 *
 * Every function here is PURE: feed it the JSON a live endpoint returned and it hands back
 * `BeadData`. That keeps them unit-testable without standing up the fleet, and keeps the
 * knowledge of each backend's quirks in one readable place.
 */
import type { BeadData, BeadLink, BeadNode, BeadStatus } from '../types';

/** Epoch fallback for records with no timestamp — placed at the cluster core (oldest). */
const UNKNOWN_CREATED_AT = new Date(0).toISOString();

const iso = (value: unknown, fallback = UNKNOWN_CREATED_AT): string => {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? fallback : new Date(parsed).toISOString();
};

/* ────────────────────────────── Expeditions ──────────────────────────────────
 * `GET /expedition/{id}/tasks` on Genesis (:8001).
 * Backed by SQLite (`Library/Data/expeditions.db`) — the only work store here that
 * both survives a restart AND carries explicit dependencies.
 * See AitherOS/lib/orchestration/ExpeditionManager.py (ExpeditionTask).
 */

export interface ExpeditionTaskRecord {
  id: string;
  expedition_id?: string;
  phase_id?: string;
  title: string;
  /** pending | in_progress | completed | failed | skipped */
  status?: string;
  assigned_to?: string | null;
  /** JSON array, or an already-parsed array, of task ids this task waits on. */
  depends_on?: string | string[] | null;
  execution_method?: string;
  created_at?: string;
  started_at?: string;
  attempt?: number;
}

const EXPEDITION_STATUS: Record<string, BeadStatus> = {
  pending: 'open',
  in_progress: 'in_progress',
  completed: 'done',
  failed: 'blocked',
  skipped: 'deferred',
};

/** `depends_on` arrives as a JSON string from SQLite but as an array from some routers. */
function parseIdList(value: string | string[] | null | undefined): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  if (typeof value !== 'string' || value.trim() === '') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string') : [];
  } catch {
    // Tolerate a plain comma-separated list.
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
}

export function fromExpeditionTasks(
  tasks: ExpeditionTaskRecord[],
  { clusterBy = 'expedition' }: { clusterBy?: 'expedition' | 'phase' | 'assignee' } = {},
): BeadData {
  const nodes: BeadNode[] = tasks.map((task) => {
    const status = EXPEDITION_STATUS[(task.status ?? '').toLowerCase()] ?? 'open';
    const cluster =
      clusterBy === 'phase'
        ? (task.phase_id ?? 'unphased')
        : clusterBy === 'assignee'
          ? (task.assigned_to ?? 'unassigned')
          : (task.expedition_id ?? 'unassigned');
    return {
      id: task.id,
      title: task.title,
      cluster,
      status,
      assignee: status === 'in_progress' ? (task.assigned_to ?? null) : null,
      createdAt: iso(task.created_at),
      stateStartedAt: task.started_at ? iso(task.started_at) : null,
      meta: {
        expeditionId: task.expedition_id,
        phaseId: task.phase_id,
        executionMethod: task.execution_method,
        attempt: task.attempt,
        rawStatus: task.status,
      },
    };
  });

  const known = new Set(nodes.map((node) => node.id));
  const links: BeadLink[] = [];
  for (const task of tasks) {
    for (const dependency of parseIdList(task.depends_on)) {
      // A dependency IS a blocker — render it as the orange dashed link, pointing
      // from the thing that must finish first to the thing waiting on it.
      if (known.has(dependency) && dependency !== task.id) {
        links.push({ source: dependency, target: task.id, kind: 'blocks' });
      }
    }
  }
  return { nodes, links };
}

/* ─────────────────────────────── TaskHub ─────────────────────────────────────
 * `GET /tasks` on Genesis (:8001) — AitherGenesis/routers/taskhub.py.
 *
 * ⚠️ This store is IN-MEMORY: a Genesis restart empties it, and it has no blocker field
 * (only parent/child). Good for "what is the fleet doing right now", useless as history.
 */

export interface TaskHubRecord {
  id: string;
  title: string;
  status?: string;
  agent?: string | null;
  priority?: string;
  created_at?: string;
  started_at?: string;
  completed_at?: string;
  parent_task_id?: string | null;
  child_task_ids?: string[];
  tags?: string[];
  progress_pct?: number;
  source?: string;
}

const TASKHUB_STATUS: Record<string, BeadStatus> = {
  pending: 'open',
  queued: 'open',
  planning: 'in_progress',
  in_progress: 'in_progress',
  awaiting_input: 'blocked',
  paused: 'blocked',
  failed: 'blocked',
  completed: 'done',
  cancelled: 'deferred',
};

export function fromTaskHub(
  tasks: TaskHubRecord[],
  { clusterBy = 'agent' }: { clusterBy?: 'agent' | 'tag' | 'source' } = {},
): BeadData {
  const nodes: BeadNode[] = tasks.map((task) => {
    const status = TASKHUB_STATUS[(task.status ?? '').toLowerCase()] ?? 'open';
    const cluster =
      clusterBy === 'tag'
        ? (task.tags?.[0] ?? 'untagged')
        : clusterBy === 'source'
          ? (task.source ?? 'local')
          : (task.agent ?? 'unassigned');
    return {
      id: task.id,
      title: task.title,
      cluster,
      status,
      assignee: status === 'in_progress' ? (task.agent ?? null) : null,
      createdAt: iso(task.created_at),
      stateStartedAt: task.started_at ? iso(task.started_at) : null,
      meta: {
        priority: task.priority,
        progressPct: task.progress_pct,
        source: task.source,
        rawStatus: task.status,
      },
    };
  });

  const known = new Set(nodes.map((node) => node.id));
  const links: BeadLink[] = [];
  const seen = new Set<string>();
  const addHierarchy = (parent: string, child: string) => {
    const key = `${parent}→${child}`;
    if (parent === child || seen.has(key) || !known.has(parent) || !known.has(child)) return;
    seen.add(key);
    links.push({ source: parent, target: child, kind: 'parent-child' });
  };
  for (const task of tasks) {
    if (task.parent_task_id) addHierarchy(task.parent_task_id, task.id);
    // Both directions are recorded in TaskHub; dedupe rather than trusting one side.
    for (const child of task.child_task_ids ?? []) addHierarchy(task.id, child);
  }
  return { nodes, links };
}

/* ───────────────────────────── Tech-debt ledger ───────────────────────────────
 * TECH_DEBT.md is the source of truth and has NO machine-readable export — the only
 * tool against it (`dev/tools/next_debt_id.py`) just computes the next id. So there is
 * currently no producer for this adapter's input; callers must parse the ledger
 * themselves. Building the exporter is recorded as open work in that ledger.
 */

export interface DebtRecord {
  /** e.g. "D-42" */
  id: string;
  /** P0 | P1 | P2 | P3 */
  severity: string;
  area?: string;
  description: string;
  /** Files the row names, used to derive cross-links. */
  files?: string[];
  date?: string;
  /** open | resolved | refuted */
  state?: string;
}

const DEBT_STATUS: Record<string, BeadStatus> = {
  open: 'open',
  resolved: 'done',
  refuted: 'done',
};

export function fromDebtLedger(
  rows: DebtRecord[],
  {
    clusterBy = 'severity',
    linkSharedFiles = true,
    /** Guard against a single hot file (TECH_DEBT.md itself, a mega-module) fusing the graph. */
    maxFileFanout = 6,
  }: {
    clusterBy?: 'severity' | 'area';
    linkSharedFiles?: boolean;
    maxFileFanout?: number;
  } = {},
): BeadData {
  const nodes: BeadNode[] = rows.map((row) => ({
    id: row.id,
    title: row.description,
    cluster: clusterBy === 'area' ? (row.area ?? 'unfiled') : row.severity,
    status: DEBT_STATUS[(row.state ?? 'open').toLowerCase()] ?? 'open',
    assignee: null,
    createdAt: iso(row.date),
    stateStartedAt: null,
    meta: { severity: row.severity, area: row.area, files: row.files, state: row.state },
  }));

  const links: BeadLink[] = [];
  if (linkSharedFiles) {
    // Debt rows carry no dependencies, so the only honest relationship available is
    // "these two rows touch the same file" — rendered as a cross-link, not a blocker.
    const byFile = new Map<string, string[]>();
    for (const row of rows) {
      for (const file of row.files ?? []) {
        const bucket = byFile.get(file) ?? [];
        bucket.push(row.id);
        byFile.set(file, bucket);
      }
    }
    const seen = new Set<string>();
    for (const ids of byFile.values()) {
      if (ids.length < 2 || ids.length > maxFileFanout) continue;
      for (let i = 0; i < ids.length; i += 1) {
        for (let j = i + 1; j < ids.length; j += 1) {
          const key = [ids[i], ids[j]].sort().join('→');
          if (seen.has(key)) continue;
          seen.add(key);
          links.push({ source: ids[i], target: ids[j], kind: 'related' });
        }
      }
    }
  }
  return { nodes, links };
}

/**
 * Union several work sources into one universe.
 *
 * Ids are namespaced (`expedition:task-1`, `debt:D-42`) so two backends cannot collide,
 * and clusters are prefixed so each source keeps its own constellations.
 */
export function mergeWorkGraphs(
  sources: Array<{ prefix: string; data: BeadData }>,
): BeadData {
  const nodes: BeadNode[] = [];
  const links: BeadLink[] = [];
  for (const { prefix, data } of sources) {
    for (const node of data.nodes) {
      nodes.push({ ...node, id: `${prefix}:${node.id}`, cluster: `${prefix}/${node.cluster}` });
    }
    for (const link of data.links) {
      links.push({ ...link, source: `${prefix}:${link.source}`, target: `${prefix}:${link.target}` });
    }
  }
  return { nodes, links };
}
