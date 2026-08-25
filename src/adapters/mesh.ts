/**
 * Mesh-routing adapter — AitherNet topology + expert routing as a universe.
 *
 * The picture behind "see the LLM's mind light up across the mesh":
 *   - endpoints (GPU hosts, pool nodes, services) are planets;
 *   - meshes are galaxies — cluster = mesh, and a mesh-of-meshes federation is
 *     just a hierarchical cluster name (`home/dgx`, `federation/edge`);
 *   - a request or agent hopping endpoint→endpoint is a link;
 *   - an agent actively being served on a node owns it, so its ship orbits there —
 *     an agent hopping between meshes reads as a ship moving between galaxies;
 *   - every planet's meta carries what it served, AGGREGATED from the routing
 *     traces: models, GPUs, layers, MoE experts, request count. Click a node and
 *     see "this endpoint served layers {3,7,19} on {A100} with experts {2,5}";
 *   - each (agent, request) trace is its own planet in the `traces` cluster with
 *     the full layer×expert activation list and the node chain it crossed — that
 *     is the individual agent trace, visible as its own body in the sky.
 *
 * The SAME records emit a world-model training corpus: `toWorldModelTransitions`
 * converts each request into the fabric world model's
 * (state, action, predicted, observed, surprise) transition schema, so the visual
 * and the training data are one stream — the world model (and the world model of
 * world models) records exactly what this universe paints.
 *
 * Input is the routing-trace shape the coordinator emits (the same JSONL the
 * Python `routing_visualizer` parses), optionally enriched with routing fields
 * (from_node/to_node/mesh/gpu/model/agent). Every field is optional — an absent
 * field yields a still-legible universe, never a crash.
 */
import type { BeadData, BeadLink, BeadNode, BeadStatus } from '../types';
import { syntheticCreatedAt } from './graph';

/** One expert-activation event, as the coordinator records it. */
export interface RoutingTraceRecord {
  request_id: string;
  agent?: string;
  /** Hop origin endpoint; absent for the first hop. */
  from_node?: string;
  /** Endpoint that served this event. */
  to_node?: string;
  /** Mesh the serving endpoint belongs to. */
  mesh?: string;
  /** GPU that served this layer. */
  gpu?: string;
  model?: string;
  layer?: number;
  expert?: number;
  score?: number;
  timestamp?: string;
}

/** An endpoint the caller knows about but may not have traffic for yet. */
export interface MeshEndpointRecord {
  id: string;
  name?: string;
  mesh?: string;
  gpu?: string;
  model?: string;
  status?: string;
}

export interface MeshRoutingOptions {
  /** Endpoints to render even with zero traffic (the topology, not just the activity). */
  endpoints?: MeshEndpointRecord[];
  /** Cap on per-request trace planets — a firehose stays legible. Default 200. */
  maxTraces?: number;
  /** Cluster name for the per-request trace planets. Default 'traces'. */
  tracesCluster?: string;
}

export interface WorldModelTransition {
  domain: string;
  state: Record<string, unknown>;
  action: Record<string, unknown>;
  /** What the intent engine predicted before the fact; null when none recorded. */
  predicted: Record<string, unknown> | null;
  observed: Record<string, unknown>;
  /** |predicted − observed|; null when there was no prediction to compare. */
  surprise: number | null;
  timestamp?: string;
}

const iso = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0) return new Date(0).toISOString();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? new Date(0).toISOString() : new Date(parsed).toISOString();
};

/** Endpoints in serving order; a node with no traffic sorts after any that has some. */
function endpointKey(record: RoutingTraceRecord): string {
  return record.to_node || record.from_node || 'unknown-endpoint';
}

export function fromMeshRouting(
  records: RoutingTraceRecord[],
  options: MeshRoutingOptions = {},
): BeadData {
  const maxTraces = options.maxTraces ?? 200;
  const tracesCluster = options.tracesCluster ?? 'traces';
  const declared = new Map((options.endpoints ?? []).map((ep) => [ep.id, ep]));

  // One planet per endpoint, aggregating everything it served.
  const byEndpoint = new Map<string, {
    endpoint: MeshEndpointRecord;
    requests: Set<string>;
    agents: Set<string>;
    layers: Set<number>;
    experts: Set<number>;
    gpus: Set<string>;
    models: Set<string>;
    lastAgent: string | null;
    lastTs: string | null;
  }>();

  for (const record of records) {
    const key = endpointKey(record);
    let bucket = byEndpoint.get(key);
    if (!bucket) {
      const endpoint: MeshEndpointRecord = declared.get(key) ?? {
        id: key,
        name: key,
        mesh: record.mesh,
        gpu: record.gpu,
        model: record.model,
      };
      bucket = {
        endpoint,
        requests: new Set(),
        agents: new Set(),
        layers: new Set(),
        experts: new Set(),
        gpus: new Set(),
        models: new Set(),
        lastAgent: null,
        lastTs: null,
      };
      byEndpoint.set(key, bucket);
    }
    if (record.request_id) bucket.requests.add(record.request_id);
    if (record.agent) {
      bucket.agents.add(record.agent);
      bucket.lastAgent = record.agent;
    }
    if (typeof record.layer === 'number') bucket.layers.add(record.layer);
    if (typeof record.expert === 'number') bucket.experts.add(record.expert);
    if (record.gpu) bucket.gpus.add(record.gpu);
    if (record.model) bucket.models.add(record.model);
    if (record.timestamp) bucket.lastTs = record.timestamp;
  }

  // Declared endpoints with no traffic render too — the topology should be visible
  // before the first request, not only once something is being served.
  for (const endpoint of options.endpoints ?? []) {
    if (!byEndpoint.has(endpoint.id)) {
      byEndpoint.set(endpoint.id, {
        endpoint,
        requests: new Set(),
        agents: new Set(),
        layers: new Set(),
        experts: new Set(),
        gpus: new Set(),
        models: new Set(),
        lastAgent: null,
        lastTs: null,
      });
    }
  }

  const entries = [...byEndpoint.values()];
  const byTraffic = [...entries].sort((a, b) => {
    const da = a.requests.size, db = b.requests.size;
    if (da !== db) return db - da;
    return (a.endpoint.id < b.endpoint.id ? -1 : 1);
  });
  const rank = new Map(byTraffic.map((entry, index) => [entry.endpoint.id, index]));
  const maxRank = Math.max(1, entries.length - 1);

  const nodes: BeadNode[] = entries.map((entry) => {
    const serving = entry.requests.size > 0;
    const status: BeadStatus = serving ? 'in_progress' : 'open';
    const label = entry.endpoint.name || entry.endpoint.id;
    const title = serving
      ? `${label} — ${entry.requests.size} req · ${entry.experts.size} experts`
      : label;

    return {
      id: entry.endpoint.id,
      title,
      cluster: entry.endpoint.mesh || 'mesh',
      status,
      // An agent actively served on this node owns it → its ship orbits here. That is
      // what makes cross-mesh agent movement visible: the ship moves between galaxies.
      assignee: entry.lastAgent,
      createdAt: syntheticCreatedAt(rank.get(entry.endpoint.id) ?? maxRank, 0, maxRank),
      stateStartedAt: entry.lastTs ? iso(entry.lastTs) : null,
      meta: {
        mesh: entry.endpoint.mesh,
        gpu: entry.endpoint.gpu,
        model: entry.endpoint.model,
        requestCount: entry.requests.size,
        agents: [...entry.agents],
        layers: [...entry.layers].sort((a, b) => a - b),
        experts: [...entry.experts].sort((a, b) => a - b),
        gpus: [...entry.gpus],
        models: [...entry.models],
      },
    };
  });

  const known = new Set(nodes.map((node) => node.id));

  // Hop links: request routed endpoint→endpoint. One edge per pair, even if traffic
  // crossed it repeatedly — the weight lives in the planets' request counts.
  const links: BeadLink[] = [];
  const seen = new Set<string>();
  const hop = (a: string, b: string) => {
    if (!a || !b || a === b || !known.has(a) || !known.has(b)) return;
    const key = `${a}→${b}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ source: a, target: b, kind: 'related' });
  };
  for (const record of records) {
    if (record.from_node && record.to_node) hop(record.from_node, record.to_node);
  }

  // Per-(agent, request) trace planets: the individual agent trace, with its full
  // activation list and the node chain it crossed. Capped so a firehose stays legible.
  const byTrace = new Map<
    string,
    { agent: string; request_id: string; events: RoutingTraceRecord[]; ts?: string }
  >();
  for (const record of records) {
    if (!record.request_id) continue;
    const agent = record.agent ?? 'agent';
    const key = `${agent}:${record.request_id}`;
    let bucket = byTrace.get(key);
    if (!bucket) {
      bucket = { agent, request_id: record.request_id, events: [], ts: record.timestamp };
      byTrace.set(key, bucket);
    }
    bucket.events.push(record);
  }
  let traceCount = 0;
  for (const [key, trace] of byTrace) {
    if (traceCount >= maxTraces) break;
    traceCount += 1;
    const chain = trace.events
      .map((ev) => ev.from_node || ev.to_node)
      .filter((node, index, all): node is string => Boolean(node) && all.indexOf(node) === index);
    const experts = trace.events
      .filter((ev) => typeof ev.layer === 'number' && typeof ev.expert === 'number')
      .map((ev) => ({ layer: ev.layer as number, expert: ev.expert as number, score: ev.score }));
    nodes.push({
      id: key,
      title: `${trace.agent}: ${trace.request_id}`,
      cluster: tracesCluster,
      status: 'open',
      assignee: trace.agent,
      createdAt: trace.ts ? iso(trace.ts) : new Date(0).toISOString(),
      meta: {
        agent: trace.agent,
        requestId: trace.request_id,
        events: trace.events.length,
        hops: chain,
        experts: experts.slice(0, 200),
      },
    });
    for (const nodeId of chain) {
      if (known.has(nodeId)) links.push({ source: key, target: nodeId, kind: 'related' });
    }
  }

  return { nodes, links };
}

/**
 * Convert routing traces to world-model transitions — the corpus that trains the
 * world model of world models. `predicted` is null (and `surprise` null) when no
 * prediction was recorded; the world model must not invent one. A trace with no
 * observed expert activation still yields a transition — a request that fired
 * nothing is data.
 */
export function toWorldModelTransitions(
  records: RoutingTraceRecord[],
): WorldModelTransition[] {
  const byTrace = new Map<string, RoutingTraceRecord[]>();
  for (const record of records) {
    if (!record.request_id) continue;
    const list = byTrace.get(record.request_id) ?? [];
    list.push(record);
    byTrace.set(record.request_id, list);
  }

  const transitions: WorldModelTransition[] = [];
  for (const [requestId, events] of byTrace) {
    const agents = [...new Set(events.map((ev) => ev.agent).filter(Boolean))];
    const nodes = [...new Set(events.map((ev) => ev.to_node || ev.from_node).filter(Boolean))];
    const layers = [...new Set(events.map((ev) => ev.layer).filter((l): l is number => typeof l === 'number'))];
    const experts = [...new Set(events.map((ev) => ev.expert).filter((e): e is number => typeof e === 'number'))];
    const meshes = [...new Set(events.map((ev) => ev.mesh).filter(Boolean))];
    const gpus = [...new Set(events.map((ev) => ev.gpu).filter(Boolean))];
    const timestamp = events.find((ev) => ev.timestamp)?.timestamp;

    transitions.push({
      domain: 'inference_fabric',
      state: { request: requestId, nodes, meshes, gpus },
      action: { agents, intent: requestId },
      predicted: null, // no prediction recorded yet — never fabricate one
      observed: { layers, experts, served_by: nodes },
      surprise: null,
      timestamp,
    });
  }
  return transitions;
}
