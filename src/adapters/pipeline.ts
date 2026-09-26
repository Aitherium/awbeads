/**
 * Pipeline-universe adapter: the training pipeline as one universe.
 *
 * Input is the shared document `aither.pipeline-universe/v1`, built by
 * `AitherOS/lib/training/pipeline_universe.py` and served by the tunnel at
 * `GET /tunnel/training/universe`. It carries two record kinds:
 *
 *   runs   latest `aither.training-run-event/v1` record of every run in the telemetry
 *          spool (lib/training/train_telemetry.py): a Lambda fine-tune attempt, a teacher
 *          rollout, an eval, a download, a workflow.
 *   tasks  the pipeline's STRUCTURE (the Kaggle comp manifest): what exists, what feeds
 *          what. A task names the runs that execute it, so re-executed attempts hang
 *          under one task instead of floating free.
 *
 * Mapping:
 *   cluster      = lane: finetune | teachers | eval | data | workflows (PIPELINE_CLUSTER_ORDER)
 *   planet       = a task, a run, or a checkpoint
 *   parent-child = task -> run -> checkpoint
 *   blocks       = an unmet dependency (teacher trajectories -> tool_lora training). Once
 *                  the upstream is done the edge is drawn as `related`: a satisfied
 *                  dependency is history, not a blocker.
 *   ship         = whoever is working it: the GPU on a run, the agent on a task.
 *
 * PURE: feed it the JSON, get BeadData. No fetch, no clock unless you omit `now`.
 */
import type { BeadData, BeadLink, BeadNode, BeadStatus } from '../types';

export const PIPELINE_SCHEMA = 'aither.pipeline-universe/v1';

/** Pin this as `clusterOrder` so lane colours do not reshuffle as lanes grow. */
export const PIPELINE_CLUSTER_ORDER = ['finetune', 'teachers', 'eval', 'data', 'workflows'];

/** training-run-event kind -> lane. */
const KIND_LANE: Record<string, string> = {
  finetune: 'finetune',
  teacher_rollout: 'teachers',
  eval: 'eval',
  download: 'data',
  workflow: 'workflows',
};

const TERMINAL: Record<string, BeadStatus> = {
  completed: 'done',
  done: 'done',
  failed: 'blocked',
  blocked: 'blocked',
  cancelled: 'deferred',
  deferred: 'deferred',
  queued: 'open',
  open: 'open',
  pending: 'open',
};

export interface CheckpointRecord {
  step?: number | null;
  tag?: string | null;
  base_antidegen?: number | null;
  tuned_antidegen?: number | null;
  delta?: number | null;
  n?: number | null;
  at?: string | null;
}

/** `aither.training-run-event/v1`. Every field optional except run_id: readers must be lenient. */
export interface TrainingRunEventRecord {
  schema?: string;
  seq?: number;
  run_id: string;
  kind?: string;
  state?: string;
  message?: string;
  step?: number | null;
  total_steps?: number | null;
  epoch?: number | null;
  loss?: number | null;
  lr?: number | null;
  eval?: CheckpointRecord | null;
  tokens_per_s?: number | null;
  gpu?: string | null;
  usd_per_hr?: number | null;
  cost_so_far_usd?: number | null;
  eta_s?: number | null;
  started_at?: string | null;
  state_since?: string | null;
  updated_at?: string | null;
  host?: string | null;
  source?: string | null;
  links?: Record<string, string> | null;
  meta?: {
    parent_run?: string;
    pipeline_task?: string;
    blocked_by?: string[];
    checkpoints?: CheckpointRecord[];
    [key: string]: unknown;
  } | null;
}

export interface PipelineTaskRecord {
  id: string;
  title?: string;
  /** Lane. Falls back to `kind` mapped through the run-event kinds, then `workflows`. */
  lane?: string;
  kind?: string;
  /** Bead status or a run-event state. Absent = derived from the task's runs. */
  status?: string | null;
  /** Where the status came from: telemetry | artifact | manual | unknown. */
  status_source?: string;
  agent?: string | null;
  gpu?: string | null;
  created_at?: string | null;
  state_since?: string | null;
  parent?: string | null;
  /** Task or run ids that must finish first. */
  blocked_by?: string[];
  /** Run ids executing this task (in addition to runs whose meta.pipeline_task names it). */
  run_ids?: string[];
  href?: string | null;
  meta?: Record<string, unknown> | null;
}

export interface PipelineUniverseRecord {
  schema?: string;
  generated_at?: string;
  runs?: TrainingRunEventRecord[];
  tasks?: PipelineTaskRecord[];
}

export interface PipelineUniverseOptions {
  /** Draw checkpoint planets under each run (default true). */
  checkpoints?: boolean;
  /** Keep only the newest N checkpoints of a run (default 12): a long run must not flood a lane. */
  maxCheckpointsPerRun?: number;
  /**
   * A non-terminal run silent for longer than this is drawn `blocked` with
   * `meta.stale = true` (default 10 min -- the same window as train_telemetry.STALE_AFTER_S,
   * the tunnel ops section and pulse's TRAIN_STALE_AFTER_S, so the views cannot disagree;
   * 0 disables). A run the SERVER already judged `stale: true` (load_runs, server clock)
   * is stale too, so browser clock skew cannot revive it. A driver that died without
   * writing `failed` must not keep a ship orbiting forever.
   */
  staleAfterMs?: number;
  /** Clock for the stale check. Defaults to `Date.now()`; pass one for deterministic tests. */
  now?: number;
}

const EPOCH = new Date(0).toISOString();

const iso = (value: unknown, fallback = EPOCH): string => {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? fallback : new Date(parsed).toISOString();
};

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

function runStatus(state: string | undefined): BeadStatus {
  const s = (state ?? '').toLowerCase();
  if (s === '') return 'open';
  return TERMINAL[s] ?? 'in_progress';
}

function laneOf(kind: string | undefined, lane?: string): string {
  if (lane) return lane;
  return KIND_LANE[(kind ?? '').toLowerCase()] ?? 'workflows';
}

const runNodeId = (runId: string) => `run:${runId}`;
const taskNodeId = (taskId: string) => `task:${taskId}`;

function runTitle(run: TrainingRunEventRecord, stale: boolean, silentMin: number): string {
  const step = num(run.step);
  const total = num(run.total_steps);
  const loss = num(run.loss);
  const parts = [run.run_id, `[${run.state ?? 'unknown'}`];
  if (step !== null && total) parts[1] += ` ${step}/${total}`;
  parts[1] += ']';
  if (loss !== null) parts.push(`loss ${loss.toFixed(4)}`);
  if (stale) parts.push(`(silent ${silentMin}m)`);
  return parts.join(' ');
}

function checkpointsOf(run: TrainingRunEventRecord): CheckpointRecord[] {
  const list = run.meta?.checkpoints;
  if (Array.isArray(list) && list.length > 0) return list.filter((c) => c && typeof c === 'object');
  return run.eval && typeof run.eval === 'object' ? [run.eval] : [];
}

export function fromPipelineUniverse(
  doc: PipelineUniverseRecord,
  {
    checkpoints = true,
    maxCheckpointsPerRun = 12,
    staleAfterMs = 10 * 60_000,
    now,
  }: PipelineUniverseOptions = {},
): BeadData {
  const clock = now ?? Date.now();
  const runs = (Array.isArray(doc?.runs) ? doc.runs : []).filter(
    (r): r is TrainingRunEventRecord => !!r && typeof r.run_id === 'string' && r.run_id !== '',
  );
  const tasks = (Array.isArray(doc?.tasks) ? doc.tasks : []).filter(
    (t): t is PipelineTaskRecord => !!t && typeof t.id === 'string' && t.id !== '',
  );

  const nodes: BeadNode[] = [];
  const links: BeadLink[] = [];
  const byId = new Map<string, BeadNode>();
  const add = (node: BeadNode) => {
    if (byId.has(node.id)) return;
    byId.set(node.id, node);
    nodes.push(node);
  };

  // task id -> its runs (explicit run_ids, or runs that name the task)
  const taskRuns = new Map<string, TrainingRunEventRecord[]>();
  const runById = new Map(runs.map((r) => [r.run_id, r]));
  for (const task of tasks) {
    const own = (task.run_ids ?? []).map((id) => runById.get(id)).filter(Boolean) as TrainingRunEventRecord[];
    for (const run of runs) {
      if (run.meta?.pipeline_task === task.id && !own.includes(run)) own.push(run);
    }
    own.sort((a, b) => iso(a.started_at ?? a.updated_at).localeCompare(iso(b.started_at ?? b.updated_at)));
    taskRuns.set(task.id, own);
  }
  const runTask = new Map<string, string>();
  for (const [taskId, own] of taskRuns) for (const run of own) if (!runTask.has(run.run_id)) runTask.set(run.run_id, taskId);

  // ── runs ──────────────────────────────────────────────────────────────────
  const runNodeStatus = new Map<string, BeadStatus>();
  for (const run of runs) {
    let status = runStatus(run.state);
    const updated = Date.parse(run.updated_at ?? '');
    const silentMs = Number.isNaN(updated) ? 0 : clock - updated;
    const stale = status === 'in_progress' && staleAfterMs > 0
      && (silentMs > staleAfterMs || (run as { stale?: unknown }).stale === true);
    if (stale) status = 'blocked';
    runNodeStatus.set(run.run_id, status);
    const parentTask = runTask.get(run.run_id);
    const lane = laneOf(run.kind, parentTask ? laneFor(tasks.find((t) => t.id === parentTask)) : undefined);
    add({
      id: runNodeId(run.run_id),
      title: runTitle(run, stale, Math.round(silentMs / 60_000)),
      cluster: lane,
      status,
      // A ship only for work in flight: the GPU renting the time, else the host driving it.
      assignee: status === 'in_progress' ? (run.gpu || run.host || null) : null,
      createdAt: iso(run.started_at ?? run.updated_at),
      stateStartedAt: run.state_since ? iso(run.state_since) : null,
      href: run.links?.dashboard || undefined,
      meta: {
        type: 'run',
        runId: run.run_id,
        kind: run.kind ?? null,
        state: run.state ?? null,
        step: num(run.step),
        totalSteps: num(run.total_steps),
        loss: num(run.loss),
        etaS: num(run.eta_s),
        costSoFarUsd: num(run.cost_so_far_usd),
        gpu: run.gpu ?? null,
        updatedAt: run.updated_at ?? null,
        stale,
      },
    });

    if (!checkpoints) continue;
    const ckpts = checkpointsOf(run).slice(-Math.max(0, maxCheckpointsPerRun));
    ckpts.forEach((ck, i) => {
      const key = ck.tag || (num(ck.step) !== null ? `step-${ck.step}` : `ckpt-${i}`);
      const delta = num(ck.delta);
      const id = `ckpt:${run.run_id}#${key}`;
      add({
        id,
        title: `${key}${delta !== null ? ` Δ${delta >= 0 ? '+' : ''}${delta.toFixed(3)}` : ''}`,
        cluster: lane,
        // A checkpoint that scored WORSE than base is the thing to see: draw it as a blocker.
        status: delta !== null && delta < 0 ? 'blocked' : 'done',
        assignee: null,
        createdAt: iso(ck.at ?? run.updated_at ?? run.started_at),
        meta: {
          type: 'checkpoint',
          runId: run.run_id,
          step: num(ck.step),
          delta,
          baseAntidegen: num(ck.base_antidegen),
          tunedAntidegen: num(ck.tuned_antidegen),
          n: num(ck.n),
        },
      });
      links.push({ source: runNodeId(run.run_id), target: id, kind: 'parent-child' });
    });
  }

  // ── tasks ─────────────────────────────────────────────────────────────────
  for (const task of tasks) {
    const own = taskRuns.get(task.id) ?? [];
    const latest = own[own.length - 1];
    let status: BeadStatus;
    let source = task.status_source ?? (task.status ? 'manual' : 'unknown');
    if (task.status) {
      status = runStatus(task.status);
    } else if (latest) {
      status = runNodeStatus.get(latest.run_id) ?? 'open';
      source = 'telemetry';
    } else {
      status = 'open';
    }
    const agent = task.agent || task.gpu || (status === 'in_progress' && latest ? latest.gpu || latest.host : null);
    add({
      id: taskNodeId(task.id),
      title: task.title || task.id,
      cluster: laneFor(task),
      status,
      assignee: status === 'in_progress' ? agent || null : null,
      createdAt: iso(task.created_at ?? own[0]?.started_at),
      stateStartedAt: task.state_since ? iso(task.state_since) : latest?.state_since ? iso(latest.state_since) : null,
      href: task.href || undefined,
      meta: { ...(task.meta ?? {}), type: 'task', taskId: task.id, statusSource: source, runs: own.length },
    });
    for (const run of own) {
      links.push({ source: taskNodeId(task.id), target: runNodeId(run.run_id), kind: 'parent-child' });
    }
  }

  // ── hierarchy + dependencies ─────────────────────────────────────────────
  const resolve = (ref: string): string | null => {
    if (byId.has(taskNodeId(ref))) return taskNodeId(ref);
    if (byId.has(runNodeId(ref))) return runNodeId(ref);
    return byId.has(ref) ? ref : null;
  };
  const dependency = (blocker: string, waiter: string) => {
    if (blocker === waiter) return;
    const done = byId.get(blocker)?.status === 'done';
    links.push({ source: blocker, target: waiter, kind: done ? 'related' : 'blocks' });
  };
  for (const task of tasks) {
    const self = taskNodeId(task.id);
    const parent = task.parent ? resolve(task.parent) : null;
    if (parent && parent !== self) links.push({ source: parent, target: self, kind: 'parent-child' });
    for (const ref of task.blocked_by ?? []) {
      const blocker = resolve(ref);
      if (blocker) dependency(blocker, self);
    }
  }
  for (const run of runs) {
    const self = runNodeId(run.run_id);
    const parentRun = run.meta?.parent_run;
    // A run already hung under its task keeps that one parent; parent_run then reads as a cross-link.
    if (parentRun) {
      const parent = resolve(parentRun);
      if (parent && parent !== self) {
        links.push({ source: parent, target: self, kind: runTask.has(run.run_id) ? 'related' : 'parent-child' });
      }
    }
    for (const ref of run.meta?.blocked_by ?? []) {
      const blocker = typeof ref === 'string' ? resolve(ref) : null;
      if (blocker) dependency(blocker, self);
    }
  }

  // Drop duplicate edges (a task naming a run AND the run naming the task).
  const seen = new Set<string>();
  const unique = links.filter((l) => {
    const key = `${l.source}>${l.target}>${l.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { nodes, links: unique };

  function laneFor(task: PipelineTaskRecord | undefined): string {
    if (!task) return 'workflows';
    return laneOf(task.kind, task.lane);
  }
}
