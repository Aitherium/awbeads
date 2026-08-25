/**
 * Compute adapter — the GPU pool as a universe.
 *
 * Source: `GET /api/compute/pool` in AitherVeil, which reads AitherMesh's `/nodes`
 * registry, drops stale/GPU-less nodes, and appends a capacity plan for a reference
 * model (bonsai-27b). The exact response shape is defined in
 * `AitherVeil/src/app/api/compute/pool/route.ts` — this adapter is written against
 * that file, field for field.
 *
 * The mapping is chosen so the picture answers "what is my compute doing right now":
 *   - a node SERVING a model is `in_progress` and owns itself, so it gets an orbiting
 *     ship — live inference reads as motion, idle capacity reads as still;
 *   - free VRAM drives radial distance, so the biggest free node sits at the cluster
 *     core and saturated nodes drift to the rim;
 *   - the capacity plan's replica/split membership becomes the link structure, so you
 *     can see which nodes would cooperate to serve the reference model.
 */
import type { BeadData, BeadLink, BeadNode, BeadStatus } from '../types';
import { syntheticCreatedAt } from './graph';

/** One pooled GPU node, as emitted by /api/compute/pool. */
export interface ComputeNodeRecord {
  node_id: string;
  name?: string;
  host?: string;
  port?: number;
  /** rtx-5090 | a100 | a6000 | dgx-grace-blackwell | unknown */
  arch?: string;
  rpc_endpoint?: string;
  vram_free_bytes?: number;
  vram_free_gb?: number;
  gpu_count?: number;
  gpu_models?: string[];
  /** Models currently resident on this node. */
  serving?: string[];
  registered_at?: string;
  last_heartbeat?: string;
}

export interface CapacityPlanRecord {
  mode?: 'route' | 'replicate' | 'split' | 'insufficient';
  target_node?: string;
  replica_nodes?: string[];
  split_plan?: Record<string, number>;
  reason?: string;
  estimated_throughput_tokps?: number;
}

export interface ComputePoolRecord {
  nodes?: ComputeNodeRecord[];
  pool_summary?: { node_count?: number; total_vram_gb?: number; total_gpu_count?: number };
  reference_model?: { name?: string; model_gb?: number };
  capacity_plan?: CapacityPlanRecord;
  /** Present only on the 503/error shape. */
  error?: string;
}

/**
 * VRAM below this (GB) counts as saturated rather than merely busy. 0.5 GB is the same
 * safety buffer the route's own planner subtracts before deciding a model fits, so a node
 * marked `blocked` here is exactly a node the planner would refuse to schedule onto.
 */
const SATURATED_VRAM_GB = 0.5;

function freeGb(node: ComputeNodeRecord): number {
  if (typeof node.vram_free_gb === 'number') return node.vram_free_gb;
  if (typeof node.vram_free_bytes === 'number') return node.vram_free_bytes / 1024 ** 3;
  return 0;
}

export function fromComputePool(pool: ComputePoolRecord): BeadData {
  const records = pool.nodes ?? [];

  // Radial distance is a RANK over free VRAM, not the raw value: a pool holding one 180 GB
  // DGX beside a 24 GB desktop card would otherwise pin every small node to the rim and
  // make them indistinguishable. Rank keeps the ordering readable at any pool spread.
  const byFree = [...records].sort((a, b) => freeGb(b) - freeGb(a));
  const rank = new Map(byFree.map((node, index) => [node.node_id, index]));
  const maxRank = Math.max(1, records.length - 1);

  const nodes: BeadNode[] = records.map((node) => {
    const serving = node.serving ?? [];
    const free = freeGb(node);
    const status: BeadStatus =
      serving.length > 0 ? 'in_progress' : free <= SATURATED_VRAM_GB ? 'blocked' : 'open';

    const label = node.name || node.host || node.node_id;
    const gpus = node.gpu_count ?? node.gpu_models?.length ?? 0;

    return {
      id: node.node_id,
      // The title carries the two numbers you actually want at a glance — how much room is
      // left and how many cards — because the tooltip is a hover away but the label is not.
      title: `${label} — ${free.toFixed(1)} GB free${gpus ? ` · ${gpus}× GPU` : ''}`,
      cluster: node.arch || 'unknown',
      status,
      // A serving node owns itself, which is what earns it an orbiting ship. Naming the
      // resident model (not the host) makes the ship's label say what is actually running.
      assignee: serving.length > 0 ? serving[0] : null,
      createdAt: syntheticCreatedAt(rank.get(node.node_id) ?? maxRank, 0, maxRank),
      stateStartedAt: node.last_heartbeat ?? null,
      meta: {
        host: node.host,
        port: node.port,
        arch: node.arch,
        gpuCount: gpus,
        gpuModels: node.gpu_models,
        vramFreeGb: Math.round(free * 10) / 10,
        serving,
        rpcEndpoint: node.rpc_endpoint,
        registeredAt: node.registered_at,
        lastHeartbeat: node.last_heartbeat,
        syntheticCreatedAt: true,
      },
    };
  });

  const known = new Set(nodes.map((node) => node.id));
  const links: BeadLink[] = [];
  const seen = new Set<string>();
  const relate = (a: string, b: string) => {
    if (a === b || !known.has(a) || !known.has(b)) return;
    const key = [a, b].sort().join('↔');
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ source: a, target: b, kind: 'related' });
  };

  // Cooperation structure comes from the capacity plan: replicas and split shards are the
  // only relationships the pool actually asserts. `route` names a single winner and
  // `insufficient` names nobody, so neither produces edges — an empty link set there is the
  // honest picture, not a missing one.
  const plan = pool.capacity_plan ?? {};
  const cohort =
    plan.mode === 'replicate'
      ? (plan.replica_nodes ?? [])
      : plan.mode === 'split'
        ? Object.keys(plan.split_plan ?? {})
        : [];
  for (let i = 0; i < cohort.length; i++) {
    for (let j = i + 1; j < cohort.length; j++) relate(cohort[i], cohort[j]);
  }

  return { nodes, links };
}

/**
 * Cluster ordering for the compute view: fastest silicon first, so the legend reads as a
 * capability ladder rather than whatever order the mesh happened to enumerate nodes in.
 * Unlisted archs fall through to the engine's own size ordering behind these.
 */
export const COMPUTE_CLUSTER_ORDER = [
  'dgx-grace-blackwell',
  'a100',
  'a6000',
  'rtx-5090',
  'unknown',
];
