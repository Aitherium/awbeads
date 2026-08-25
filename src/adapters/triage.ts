/**
 * Backlog-triage adapter — the autonomous GitHub PR/issue sweep as a universe.
 *
 * Each routine run becomes a planet in the "Backlog Triage" constellation;
 * consecutive runs link as `related`. Planet status maps run outcome (success →
 * done, failure → blocked, dry-run → open, live-but-running → in_progress).
 * The decision buckets ride in `meta`, read from the scheduler execution trace's
 * `action_result` (the tick endpoint's full report).
 */
import type { BeadData, BeadLink, BeadNode } from '../types';

export interface TriageRunRecord {
  id?: string;
  started_at?: string;
  created_at?: string;
  timestamp?: string;
  status?: string;
  duration_ms?: number;
  action_result?: {
    dry_run?: boolean;
    prs?: {
      closed?: unknown[];
      merged?: unknown[];
      commented?: unknown[];
      needs_human?: unknown[];
      kept?: unknown[];
    };
    issues?: { closed?: unknown[]; kept?: unknown[]; needs_human?: unknown[] };
    errors?: unknown[];
  };
  [key: string]: unknown;
}

function _len(list: unknown): number {
  return Array.isArray(list) ? list.length : 0;
}

function buckets(run: TriageRunRecord): Record<string, number | boolean | null> {
  const r = run.action_result || {};
  const prs = r.prs || {};
  const issues = r.issues || {};
  return {
    prs_closed: _len(prs.closed),
    prs_merged: _len(prs.merged),
    prs_needs_human: _len(prs.needs_human),
    issues_closed: _len(issues.closed),
    issues_needs_human: _len(issues.needs_human),
    dry_run: r.dry_run ?? null,
  };
}

export function fromBacklogTriage(runs: TriageRunRecord[]): BeadData {
  const nodes: BeadNode[] = [];
  const links: BeadLink[] = [];

  runs.forEach((run, i) => {
    const ts = run.started_at || run.created_at || run.timestamp;
    const id = run.id || (ts ? `triage-${ts}` : `triage-run-${i}`);
    // Radial distance from the cluster core encodes age — synthetic times for
    // untimestamped rows keep the timeline dense but ordered.
    const createdAt =
      ts || new Date(Date.now() - (runs.length - i) * 86_400_000).toISOString();
    const meta = buckets(run);
    const status: BeadNode['status'] =
      run.status === 'success'
        ? 'done'
        : run.status === 'failure' || run.status === 'error'
          ? 'blocked'
          : meta.dry_run
            ? 'open'
            : 'in_progress';

    nodes.push({
      id,
      title: `Backlog Triage — ${createdAt.slice(0, 16).replace('T', ' ')}`,
      cluster: 'Backlog Triage',
      status,
      createdAt,
      meta: { ...meta, duration_ms: run.duration_ms ?? null },
    });
  });

  for (let i = 1; i < nodes.length; i++) {
    links.push({ source: nodes[i - 1].id, target: nodes[i].id, kind: 'related' });
  }

  return { nodes, links };
}
