/**
 * Agent Activity Adapter — Agent tasks and runs as BeadSpace nodes
 *
 * Maps agent task activity (delegations, executions, completions) to BeadSpace universe.
 * Each agent task becomes a planet, grouped by agent (cluster).
 *
 * Source: GET /api/agent-activity (Veil proxy)
 * Backed by: TaskHub (in-memory) + Agent delegation logs
 */

import type { BeadData, BeadLink, BeadNode, BeadStatus } from '../types';

/** Epoch fallback for records with no timestamp — placed at cluster core (oldest). */
const UNKNOWN_CREATED_AT = new Date(0).toISOString();

const iso = (value: unknown, fallback = UNKNOWN_CREATED_AT): string => {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? fallback : new Date(parsed).toISOString();
};

export interface AgentTaskRecord {
  /** Stable unique id for this agent task. */
  id: string;
  /** Agent name/identity (e.g., "demiurge", "hydra"). */
  agent: string;
  /** Human-readable task title. */
  title: string;
  /**
   * Task status — mapped to BeadStatus:
   * - pending/queued/open → 'open'
   * - running/executing/in_progress → 'in_progress'
   * - awaiting/paused/blocked → 'blocked'
   * - completed/done/succeeded → 'done'
   * - cancelled/failed/error → 'blocked'
   */
  status?: string;
  /** When the task was created. */
  created_at?: string;
  /** When the task started executing. */
  started_at?: string;
  /** When the task completed. */
  completed_at?: string;
  /** Optional parent task id for hierarchical grouping. */
  parent_task_id?: string | null;
  /** Optional metadata (priority, effort, model, etc.). */
  metadata?: Record<string, unknown>;
}

const AGENT_STATUS: Record<string, BeadStatus> = {
  // Open states
  pending: 'open',
  queued: 'open',
  open: 'open',
  draft: 'open',
  proposed: 'open',

  // In-progress states
  running: 'in_progress',
  executing: 'in_progress',
  in_progress: 'in_progress',
  planning: 'in_progress',

  // Blocked states
  awaiting: 'blocked',
  paused: 'blocked',
  blocked: 'blocked',
  awaiting_input: 'blocked',
  failed: 'blocked',
  error: 'blocked',

  // Done states
  completed: 'done',
  done: 'done',
  succeeded: 'done',
  cancelled: 'deferred',
  deferred: 'deferred',
  skipped: 'deferred',
};

/**
 * Transform agent activity records to BeadSpace universe.
 *
 * Each agent task becomes a planet. Tasks are grouped by agent (cluster).
 * Assignee is always the agent itself — ships orbit task planets owned by their agent.
 *
 * @param tasks Array of agent task records
 * @param options Clustering and filtering options
 * @returns BeadData { nodes, links }
 */
export function fromAgentActivity(
  tasks: AgentTaskRecord[],
  {
    clusterBy = 'agent',
  }: {
    /** Group tasks by 'agent' (default) or 'status'. */
    clusterBy?: 'agent' | 'status';
  } = {},
): BeadData {
  const nodes: BeadNode[] = tasks.map((task) => {
    const status = AGENT_STATUS[(task.status ?? '').toLowerCase()] ?? 'open';
    const cluster =
      clusterBy === 'status'
        ? (task.status ?? 'unknown')
        : (task.agent ?? 'unassigned');

    return {
      id: task.id,
      title: task.title,
      cluster,
      status,
      // Assignee is the agent executing the task. Only set for in-progress tasks
      // so ships appear orbiting active work.
      assignee: status === 'in_progress' ? (task.agent ?? null) : null,
      createdAt: iso(task.created_at),
      stateStartedAt: task.started_at ? iso(task.started_at) : null,
      meta: {
        agent: task.agent,
        completedAt: task.completed_at,
        ...task.metadata,
      },
    };
  });

  // Parent-child links for hierarchical tasks
  const known = new Set(nodes.map((node) => node.id));
  const links: BeadLink[] = [];
  const seen = new Set<string>();

  for (const task of tasks) {
    if (task.parent_task_id && known.has(task.parent_task_id) && known.has(task.id)) {
      const key = `${task.parent_task_id}→${task.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        links.push({
          source: task.parent_task_id,
          target: task.id,
          kind: 'parent-child',
        });
      }
    }
  }

  return { nodes, links };
}

/**
 * Merge agent activity with other work sources into one universe.
 *
 * Namespaces agent task ids and clusters so they don't collide with
 * expeditions, TaskHub entries, or spec rows.
 */
export function mergeAgentGraphs(
  sources: Array<{ prefix: string; data: BeadData }>,
): BeadData {
  const nodes: BeadNode[] = [];
  const links: BeadLink[] = [];

  for (const { prefix, data } of sources) {
    for (const node of data.nodes) {
      nodes.push({
        ...node,
        id: `${prefix}:${node.id}`,
        cluster: `${prefix}/${node.cluster}`,
      });
    }
    for (const link of data.links) {
      links.push({
        ...link,
        source: `${prefix}:${link.source}`,
        target: `${prefix}:${link.target}`,
      });
    }
  }

  return { nodes, links };
}
