/**
 * bead-space core — an embeddable force-graph universe.
 *
 * Visual language (unchanged from upstream, see NOTICE.md):
 *   planet            = a node; radial distance from its cluster core = age (older is inner)
 *   solid line        = hierarchy (`parent-child`)
 *   orange dashed     = blocker
 *   purple dashed     = cross-link
 *   orbiting ship     = an owner with exactly one active node
 *   patrolling ship   = an owner spread across several active nodes; one full orbit at each
 *                       assignment, then a routed flight to the next, with a fading trail
 *   slow station      = active but unassigned work
 *   planet tint       = the owner's colour
 *   slower orbit      = older assignment
 */
import { group, range, rollup, extent } from 'd3-array';
import { drag } from 'd3-drag';
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
} from 'd3-force';
import { select, type Selection } from 'd3-selection';
import { line as d3line, curveCatmullRom } from 'd3-shape';
import { zoom as d3zoom, zoomIdentity, type ZoomBehavior } from 'd3-zoom';
import 'd3-transition';

import { createGeometry, trailSegments } from './geometry';
import { hash } from './hash';
import type {
  BeadData,
  BeadLink,
  BeadNode,
  BeadSpaceHandle,
  BeadSpaceOptions,
  BeadStats,
  SimNode,
  Worker,
} from '../types';

const DEFAULT_ASSET_ROOT = '/assets/kenney-simple-space';
const DEFAULT_OWNER_PALETTE = ['#4ec9ff', '#ff8bc8', '#78e6a2', '#ffc86b', '#b69cff'];
/**
 * Cluster tints, ordered most-alarming first.
 *
 * ⚠️ Colour is assigned by CLUSTER ORDER, and the default order is by size (biggest first).
 * For any data whose clusters are ORDINAL — severity, priority, layer — size order is not
 * semantic order, and the default will mislead: on the real debt ledger it painted P2 (149
 * rows) red and P0 (22 rows) green, i.e. the emergencies looked safe. Pass `clusterOrder`
 * explicitly for ordinal clusters. `fromDebtLedger` callers should pass ['P0','P1','P2','P3'].
 */
const DEFAULT_CLUSTER_PALETTE = [
  '#ff6b6b',
  '#ffa94d',
  '#ffd43b',
  '#69db7c',
  '#4dabf7',
  '#b197fc',
  '#f783ac',
  '#38d9a9',
  '#a9e34b',
  '#e599f7',
];
const PLANET_SPRITES = [
  'meteor_detailedLarge.png',
  'meteor_large.png',
  'meteor_squareDetailedLarge.png',
  'meteor_squareLarge.png',
];
const SHIP_SPRITES = ['ship_A.png', 'ship_C.png', 'ship_F.png', 'ship_J.png'];
const STATION_SPRITES = ['station_A.png', 'station_C.png'];

/** A simulation link once d3-force has resolved the endpoints to node objects. */
interface SimLink extends Omit<BeadLink, 'source' | 'target'> {
  source: SimNode | string;
  target: SimNode | string;
}

const endpointId = (endpoint: SimNode | string): string =>
  typeof endpoint === 'object' ? endpoint.id : endpoint;

/**
 * Lay clusters out on a ring, biggest first, so independent work streams get their own
 * corner of the universe. Upstream hardcoded four named anchors; real data has an unknown
 * number of clusters, so anchors are derived unless the caller supplies them.
 */
/** Cluster names, biggest first, ties broken by name so the order is stable across updates. */
function clusterNamesBySize(nodes: BeadNode[]): string[] {
  const counts = rollup(
    nodes,
    (members) => members.length,
    (node) => node.cluster,
  );
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name);
}

function deriveClusterAnchors(names: string[]): Record<string, [number, number]> {
  const anchors: Record<string, [number, number]> = {};
  if (names.length === 0) return anchors;
  if (names.length === 1) {
    anchors[names[0]] = [0.5, 0.5];
    return anchors;
  }
  // Offset by -90° so the largest cluster sits top-centre rather than hard right.
  names.forEach((name, index) => {
    const angle = (index / names.length) * Math.PI * 2 - Math.PI / 2;
    anchors[name] = [0.5 + Math.cos(angle) * 0.3, 0.5 + Math.sin(angle) * 0.3];
  });
  return anchors;
}

export function createBeadSpace(
  container: HTMLElement,
  data: BeadData,
  options: BeadSpaceOptions = {},
): BeadSpaceHandle {
  const assetRoot = (options.assetRoot ?? DEFAULT_ASSET_ROOT).replace(/\/$/, '');
  const ownerPalette =
    options.ownerPalette && options.ownerPalette.length > 0
      ? options.ownerPalette
      : DEFAULT_OWNER_PALETTE;
  const clusterPalette =
    options.clusterPalette && options.clusterPalette.length > 0
      ? options.clusterPalette
      : DEFAULT_CLUSTER_PALETTE;
  const motionAllowed =
    options.reducedMotion === true
      ? false
      : typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? !window.matchMedia('(prefers-reduced-motion: reduce)').matches
        : true;

  // ── mutable dataset ───────────────────────────────────────────────────────────
  let nodes: SimNode[] = [];
  let links: SimLink[] = [];
  let clusterAnchors: Record<string, [number, number]> = {};
  /** Clusters in stable order (biggest first) — drives cluster colour assignment. */
  let clusterOrder: string[] = [];
  let selectedId: string | null = null;
  let followedOwner: string | null = null;
  let patrolWorkers: Worker[] = [];
  let frame: number | null = null;
  let destroyed = false;
  let userMovedCamera = false;
  let tickCount = 0;
  const fitTimers: number[] = [];
  const autoFit = (): boolean =>
    options.fitToContent !== false && !userMovedCamera && followedOwner === null;

  // ── DOM ───────────────────────────────────────────────────────────────────────
  // An inner root so the host's container keeps its own classes and styling.
  const root = document.createElement('div');
  root.className = 'bead-space';
  container.appendChild(root);

  const svgElement = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svgElement.setAttribute('class', 'bead-space-map');
  svgElement.setAttribute('role', 'img');
  svgElement.setAttribute('aria-label', 'Interactive force graph');
  root.appendChild(svgElement);

  const svg = select(svgElement);
  const defs = svg.append('defs');
  // Filters are referenced by url(#id); ids must be unique when several universes coexist.
  const instanceId = `bs-${Math.random().toString(36).slice(2, 9)}`;
  const glowId = `${instanceId}-glow`;
  const shipGlowId = `${instanceId}-ship-glow`;
  for (const [id, deviation] of [
    [glowId, 3],
    [shipGlowId, 2.2],
  ] as Array<[string, number]>) {
    const filter = defs.append('filter').attr('id', id);
    filter.append('feGaussianBlur').attr('stdDeviation', deviation).attr('result', 'blur');
    const merge = filter.append('feMerge');
    merge.append('feMergeNode').attr('in', 'blur');
    merge.append('feMergeNode').attr('in', 'SourceGraphic');
  }

  const starfield = svg.append('g').attr('class', 'bs-starfield');
  const stage = svg.append('g');
  const linkLayer = stage.append('g');
  const routeLayer = stage.append('g');
  const trailLayer = stage.append('g');
  const nodeLayer = stage.append('g');
  const orbitLayer = stage.append('g');
  const stationLayer = stage.append('g');
  const patrolLayer = stage.append('g');

  const tooltip = document.createElement('aside');
  tooltip.className = 'bs-tooltip';
  tooltip.hidden = true;
  root.appendChild(tooltip);

  const followButton = document.createElement('button');
  followButton.type = 'button';
  followButton.className = 'bs-follow-mode';
  followButton.hidden = true;
  const followPulse = document.createElement('span');
  followPulse.className = 'bs-follow-pulse';
  followPulse.setAttribute('aria-hidden', 'true');
  const followLabel = document.createElement('span');
  const followOwnerName = document.createElement('strong');
  followLabel.append(document.createTextNode('Following '), followOwnerName);
  const followHint = document.createElement('small');
  followHint.textContent = 'click to exit';
  followButton.append(followPulse, followLabel, followHint);
  root.appendChild(followButton);

  // ── layout, recomputed on resize ──────────────────────────────────────────────
  let width = 0;
  let height = 0;
  let clusterSpan = 0;
  let homeScale = 1;
  let homeTransform = zoomIdentity;
  let followScale = 2.15;

  function measure(): void {
    const rect = container.getBoundingClientRect();
    // Fall back to something sane when measured inside a display:none / zero-height parent.
    width = Math.max(320, Math.round(rect.width) || 960);
    height = Math.max(240, Math.round(rect.height) || 600);
    clusterSpan = Math.min(width, height) * (width < 600 ? 0.2 : 0.15);
    homeScale = width <= 560 ? 0.76 : 1;
    followScale = width <= 560 ? 1.8 : 2.15;
    homeTransform = zoomIdentity
      .translate((width * (1 - homeScale)) / 2, (height * (1 - homeScale)) / 2)
      .scale(homeScale);
    svg.attr('viewBox', `0 0 ${width} ${height}`);
  }

  function drawStarfield(): void {
    if (options.starfield === false) {
      starfield.selectAll('circle').remove();
      return;
    }
    starfield
      .selectAll('circle')
      .data(
        range(Math.max(150, Math.floor((width * height) / 4200))).map(() => ({
          x: Math.random() * width,
          y: Math.random() * height,
          radius: 0.35 + Math.random() ** 2 * 1.35,
          opacity: 0.12 + Math.random() * 0.58,
        })),
      )
      .join('circle')
      .attr('class', 'bs-star')
      .attr('cx', (star) => star.x)
      .attr('cy', (star) => star.y)
      .attr('r', (star) => star.radius)
      .attr('opacity', (star) => star.opacity);
  }

  // ── scales / encodings ────────────────────────────────────────────────────────
  const radius = (node: SimNode): number => 8 + Math.min(13, Math.sqrt(node.degree) * 3.4);

  const ownerColor = (node: SimNode): string =>
    node.assignee ? ownerPalette[hash(node.assignee) % ownerPalette.length] : '#edf5ff';

  /**
   * What a planet is tinted by.
   *
   * Upstream only ever tinted by OWNER, because in a task universe every interesting planet
   * has one. Real AitherOS data mostly does not — a debt row, a service, a module has no
   * assignee — so every planet came out the same white and the single most important
   * dimension (severity, group, layer) was carried only by position. With overlapping
   * constellations that is no information at all.
   *
   * So: owner colour when there is an owner, cluster colour otherwise.
   */
  function tintColor(node: SimNode): string {
    if (node.assignee) return ownerColor(node);
    const index = clusterOrder.indexOf(node.cluster);
    return clusterPalette[(index < 0 ? hash(node.cluster) : index) % clusterPalette.length];
  }

  const planetSprite = (node: SimNode): string =>
    `${assetRoot}/${PLANET_SPRITES[hash(node.id) % PLANET_SPRITES.length]}`;

  const shipSprite = (node: SimNode): string =>
    `${assetRoot}/${SHIP_SPRITES[hash(node.assignee ?? node.id) % SHIP_SPRITES.length]}`;

  /** Older assignments orbit slower; each owner gets a little personal variation. */
  function orbitSeconds(node: SimNode): number {
    const startedAt = Date.parse(node.stateStartedAt ?? node.createdAt);
    const ageHours = Math.max(0, (Date.now() - startedAt) / 3_600_000);
    const personalVariation = (hash(node.assignee ?? node.id) % 140) / 100;
    return Math.min(11, 3.4 + Math.log1p(ageHours) * 0.72 + personalVariation);
  }

  const labelsAlwaysBelow = options.labelsAlwaysBelow ?? 60;
  const labelZoom = options.labelZoom ?? 1.6;

  /**
   * Default label: the title, clipped. Titles carry the meaning (a service name, an agent
   * name, a debt description); ids are frequently opaque (`task-0`, a uuid).
   */
  function labelFor(node: SimNode): string {
    if (options.nodeLabel) return options.nodeLabel(node);
    const text = node.title || node.id;
    return text.length > 32 ? `${text.slice(0, 31).trimEnd()}…` : text;
  }

  function clusterCenter(cluster: string): [number, number] {
    const [x, y] = clusterAnchors[cluster] ?? [0.5, 0.5];
    return [width * x, height * y];
  }

  const geometry = createGeometry({
    getNodes: () => nodes,
    radius,
    orbitSeconds,
    getAlpha: () => simulation.alpha(),
  });
  const trailCurve = d3line().curve(curveCatmullRom.alpha(0.6));

  /** Pulls each node to its cluster's ring at the radius its age earns it. */
  function clusterRadialForce(strength = 0.22) {
    let forceNodes: SimNode[] = [];
    function force(alpha: number) {
      for (const node of forceNodes) {
        const [centerX, centerY] = clusterCenter(node.cluster);
        const deltaX = node.x - centerX || 0.01;
        const deltaY = node.y - centerY || 0.01;
        const distance = Math.hypot(deltaX, deltaY);
        const pull = ((node.ageRadius - distance) * strength * alpha) / distance;
        node.vx = (node.vx ?? 0) + deltaX * pull;
        node.vy = (node.vy ?? 0) + deltaY * pull;
      }
    }
    force.initialize = (initializedNodes: SimNode[]) => {
      forceNodes = initializedNodes;
    };
    return force;
  }

  /** Age → radial distance from the cluster core, normalised within each cluster. */
  function assignAgeRadii(): void {
    const timestamps = nodes.map((node) => Date.parse(node.createdAt));
    const [oldest, newest] = [Math.min(...timestamps), Math.max(...timestamps)];
    const clusterDates = rollup(
      nodes,
      (members) => extent(members, (node) => Date.parse(node.createdAt)),
      (node) => node.cluster,
    );
    for (const node of nodes) {
      const [clusterOldest, clusterNewest] = clusterDates.get(node.cluster) ?? [oldest, newest];
      const ageRatio =
        clusterNewest === clusterOldest || clusterOldest === undefined
          ? 0.5
          : (Date.parse(node.createdAt) - clusterOldest) /
            ((clusterNewest as number) - clusterOldest);
      node.ageRadius = 34 + ageRatio * clusterSpan;
    }
  }

  /** Deterministic seed position so first paint is already cluster-shaped. */
  function seedPosition(node: SimNode): void {
    const angle = ((hash(node.id) % 360) * Math.PI) / 180;
    const [centerX, centerY] = clusterCenter(node.cluster);
    node.x = centerX + Math.cos(angle) * node.ageRadius;
    node.y = centerY + Math.sin(angle) * node.ageRadius;
  }

  // ── tooltip ───────────────────────────────────────────────────────────────────
  function positionTooltip(event: { clientX: number; clientY: number }): void {
    const rect = root.getBoundingClientRect();
    const left = Math.min(
      rect.width - tooltip.offsetWidth - 14,
      event.clientX - rect.left + 16,
    );
    const top = Math.min(rect.height - tooltip.offsetHeight - 14, event.clientY - rect.top + 16);
    tooltip.style.left = `${Math.max(14, left)}px`;
    tooltip.style.top = `${Math.max(14, top)}px`;
  }

  function showTooltip(event: { clientX: number; clientY: number }, node: SimNode): void {
    const title = document.createElement('strong');
    title.textContent = node.id;
    // Wrapped in an element so the stylesheet can clamp it — real descriptions run long.
    const body = document.createElement('div');
    body.className = 'bs-tip-body';
    body.textContent = node.title;
    const details = document.createElement('small');
    const assignment = node.assignee ? ` · crew ${node.assignee}` : '';
    details.textContent = `${node.status.replace('_', ' ')}${assignment} · ${node.cluster} · ${
      node.degree
    } connection${node.degree === 1 ? '' : 's'}`;
    tooltip.replaceChildren(title, body, details);
    tooltip.hidden = false;
    positionTooltip(event);
  }

  // ── camera ────────────────────────────────────────────────────────────────────
  // 🚨 `.extent()` is LOAD-BEARING, not a nicety. Without it d3-zoom falls back to
  // `defaultExtent`, which reads `svg.viewBox.baseVal` / `svg.width.baseVal` off the
  // node zoom.transform targets. Measured 2026-09-11 on aitherium.com: in Chromium
  // builds where that read yields undefined, the FIRST `svg.call(zoom.transform,
  // homeTransform)` below throws `TypeError: Cannot read properties of undefined
  // (reading 'baseVal')` from inside d3-zoom — during the Living OS boot, so the
  // whole (os) route hit the error boundary and a guest saw "Aitherium hit a snag
  // booting up" before any tile rendered (caught by the stack-aware console hook;
  // the boundary logs the Error object, which JSON-serialises to {}).
  // The explicit form never touches the DOM, so the fallback is unreachable.
  const zoom: ZoomBehavior<SVGSVGElement, unknown> = d3zoom<SVGSVGElement, unknown>()
    .extent((): [[number, number], [number, number]] => [[0, 0], [width, height]])
    .scaleExtent([0.3, 5])
    .on('zoom', (event) => {
      stage.attr('transform', event.transform.toString());
      // Zooming in is the "tell me what these are" gesture — honour it.
      root.classList.toggle(
        'bs-labels-on',
        nodes.length <= labelsAlwaysBelow || event.transform.k >= labelZoom,
      );
    });

  function followCamera(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const transform = zoomIdentity
      .translate(width / 2, height / 2)
      .scale(followScale)
      .translate(-x, -y);
    svg.call(zoom.transform, transform);
  }

  /**
   * Frame the whole universe.
   *
   * Upstream parked the camera at scale 1 on a fixed full-window canvas sized to its own
   * ~25-node sample. Real datasets are an order of magnitude bigger and spill off every edge,
   * so the default view showed a crop of a graph with no indication there was more.
   */
  function fitToContent(animate = true): void {
    if (nodes.length === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of nodes) {
      if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
      const r = radius(node) + 30; // leave room for labels and orbiting ships
      minX = Math.min(minX, node.x - r);
      maxX = Math.max(maxX, node.x + r);
      minY = Math.min(minY, node.y - r);
      maxY = Math.max(maxY, node.y + r);
    }
    if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return;

    const scale = Math.max(
      0.3,
      Math.min(2, 0.94 * Math.min(width / (maxX - minX), height / (maxY - minY))),
    );
    const transform = zoomIdentity
      .translate(width / 2, height / 2)
      .scale(scale)
      .translate(-(minX + maxX) / 2, -(minY + maxY) / 2);
    homeTransform = transform;
    if (animate && motionAllowed) {
      svg.transition().duration(500).call(zoom.transform as never, transform);
    } else {
      svg.call(zoom.transform, transform);
    }
  }

  function startFollowing(event: Event, worker: Worker): void {
    event.stopPropagation();
    followedOwner = worker.owner;
    followOwnerName.textContent = worker.owner;
    followButton.hidden = false;
    followCamera(worker.targets[0].x, worker.targets[0].y);
    options.onFollow?.(worker.owner);
  }

  function stopFollowing(): void {
    if (followedOwner !== null) options.onFollow?.(null);
    followedOwner = null;
    followButton.hidden = true;
  }

  // ── layers ────────────────────────────────────────────────────────────────────
  let linkSelection: Selection<SVGLineElement, SimLink, any, unknown> = linkLayer.selectAll(
    'line',
  ) as never;
  let nodeSelection: Selection<SVGGElement, SimNode, any, unknown> = nodeLayer.selectAll(
    'g.bs-node',
  ) as never;
  let routeSelection: Selection<SVGPathElement, Worker, any, unknown> = routeLayer.selectAll(
    'path.bs-patrol-route',
  ) as never;
  let trailSelection: Selection<SVGGElement, Worker, any, unknown> = trailLayer.selectAll(
    'g.bs-patrol-trail-group',
  ) as never;
  let orbitSelection: Selection<SVGGElement, Worker, any, unknown> = orbitLayer.selectAll(
    'g.bs-orbit',
  ) as never;
  let stationSelection: Selection<SVGGElement, SimNode, any, unknown> = stationLayer.selectAll(
    'g.bs-station-orbit',
  ) as never;
  let patrolSelection: Selection<SVGGElement, Worker, any, unknown> = patrolLayer.selectAll(
    'g.bs-patrol-worker',
  ) as never;

  function syncLinks(): void {
    linkSelection = linkLayer
      .selectAll<SVGLineElement, SimLink>('line')
      .data(links)
      .join('line')
      .attr('class', (link) => `bs-link ${link.kind === 'parent-child' ? '' : link.kind}`);
  }

  const tintFilterId = (color: string): string =>
    `${instanceId}-tint-${color.replace(/[^a-zA-Z0-9]/g, '')}`;

  /**
   * Tint: desaturate the sprite, multiply the colour through it, then clip back to the
   * sprite's own alpha so the planet keeps its silhouette.
   *
   * Keyed by COLOUR, not by node. Upstream created one filter per assigned node, which was
   * fine for a handful of crew but would emit ~360 filter elements on a real ledger.
   */
  function syncTintFilters(): void {
    const colors = [...new Set(nodes.map(tintColor))];
    const filters = defs
      .selectAll<SVGFilterElement, string>('filter.bs-tint-filter')
      .data(colors, (color) => color)
      .join((enter) => {
        const filter = enter
          .append('filter')
          .attr('class', 'bs-tint-filter')
          .attr('color-interpolation-filters', 'sRGB');
        filter
          .append('feColorMatrix')
          .attr('in', 'SourceGraphic')
          .attr('type', 'saturate')
          .attr('values', '0.18')
          .attr('result', 'planet-luminance');
        filter.append('feFlood').attr('result', 'crew-color');
        filter
          .append('feBlend')
          .attr('in', 'planet-luminance')
          .attr('in2', 'crew-color')
          .attr('mode', 'multiply')
          .attr('result', 'tinted-planet');
        filter
          .append('feComposite')
          .attr('in', 'tinted-planet')
          .attr('in2', 'SourceGraphic')
          .attr('operator', 'in');
        return filter;
      })
      .attr('id', (color) => tintFilterId(color));
    filters.select('feFlood').attr('flood-color', (color) => color as string);
  }

  function selectNode(node: SimNode | null, event?: { clientX: number; clientY: number }): void {
    selectedId = node?.id ?? null;
    if (node && event) showTooltip(event, node);
    if (!node) tooltip.hidden = true;
    updateFocus();
    options.onSelect?.(node);
  }

  function syncNodes(): void {
    syncTintFilters();
    nodeSelection = nodeLayer
      .selectAll<SVGGElement, SimNode>('g.bs-node')
      .data(nodes, (node) => node.id)
      .join((enter) => {
        const group = enter.append('g');
        group.append('circle').attr('class', 'bs-planet-core');
        group.append('image').attr('class', 'bs-planet-sprite');
        group.append('circle').attr('class', 'bs-selection-ring');
        group.append('text').attr('class', 'bs-label');
        return group;
      })
      // Status class is an AitherOS addition — upstream had no visual for blocked/deferred/done.
      .attr('class', (node) => `bs-node status-${node.status.replace('_', '-')}`)
      .attr('tabindex', 0)
      .attr('role', 'button')
      .attr('aria-label', (node) => `${node.id}: ${node.title}`)
      .on('mouseenter', (event: MouseEvent, node) => showTooltip(event, node))
      .on('mousemove', (event: MouseEvent) => positionTooltip(event))
      .on('mouseleave', () => {
        if (!selectedId) tooltip.hidden = true;
      })
      .on('click', (event: MouseEvent, node) => {
        event.stopPropagation();
        selectNode(node, event);
      })
      .on('keydown', (event: KeyboardEvent, node) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        const rect = (event.currentTarget as SVGGElement).getBoundingClientRect();
        selectNode(node, { clientX: rect.left + rect.width / 2, clientY: rect.top });
      });

    nodeSelection.select('.bs-planet-core').attr('r', (node) => radius(node as SimNode));
    nodeSelection
      .select('.bs-planet-sprite')
      .attr('href', (node) => planetSprite(node as SimNode))
      .attr('x', (node) => -radius(node as SimNode) * 1.45)
      .attr('y', (node) => -radius(node as SimNode) * 1.45)
      .attr('width', (node) => radius(node as SimNode) * 2.9)
      .attr('height', (node) => radius(node as SimNode) * 2.9)
      // Every planet is tinted now — by owner if it has one, otherwise by cluster.
      .attr('filter', (node) => `url(#${tintFilterId(tintColor(node as SimNode))})`);
    nodeSelection
      .select('.bs-selection-ring')
      .attr('r', (node) => radius(node as SimNode) * 1.48)
      // Filter ids are per-instance, so they cannot live in the stylesheet.
      .attr('filter', `url(#${glowId})`);

    nodeSelection
      .select('.bs-label')
      .attr('y', (node) => radius(node as SimNode) * 1.45 + 13)
      .text((node) => labelFor(node as SimNode));

    // A small universe is readable immediately; a crowded one waits for a zoom-in.
    root.classList.toggle('bs-labels-on', nodes.length <= labelsAlwaysBelow);

    nodeSelection.call(
      drag<SVGGElement, SimNode>()
        .on('start', (event, node) => {
          if (!event.active) simulation.alphaTarget(0.25).restart();
          node.fx = node.x;
          node.fy = node.y;
        })
        .on('drag', (event, node) => {
          node.fx = event.x;
          node.fy = event.y;
        })
        .on('end', (event, node) => {
          if (!event.active) simulation.alphaTarget(0);
          node.fx = null;
          node.fy = null;
        }),
    );
  }

  function drawOrbit(this: SVGGElement, worker: Worker): void {
    const node = worker.targets[0];
    const spinner = select(this).append('g').attr('class', 'bs-orbit-spinner');
    const orbitRadius = radius(node) + 11;
    // Fading arc tail behind the ship.
    for (const [path, opacity] of [
      [geometry.arcPath(orbitRadius, -172, -55), 0.12],
      [geometry.arcPath(orbitRadius, -108, -28), 0.4],
      [geometry.arcPath(orbitRadius, -52, -9), 0.9],
    ] as Array<[string, number]>) {
      spinner
        .append('path')
        .attr('class', 'bs-ship-tail')
        .attr('d', path)
        .attr('stroke', ownerColor(node))
        .attr('stroke-opacity', opacity)
        .attr('filter', `url(#${shipGlowId})`);
    }
    spinner
      .append('circle')
      .attr('class', 'bs-ship-hit')
      .attr('cx', orbitRadius)
      .attr('cy', 0)
      .attr('r', 13)
      .on('click', (event: MouseEvent) => startFollowing(event, worker));
    spinner
      .append('image')
      .attr('class', 'bs-ship')
      .attr('href', shipSprite(node))
      .attr('x', orbitRadius - 9)
      .attr('y', -9)
      .attr('width', 18)
      .attr('height', 18)
      .attr('transform', `rotate(180 ${orbitRadius} 0)`);
  }

  function drawStation(this: SVGGElement, node: SimNode): void {
    const spinner = select(this).append('g');
    if (motionAllowed) {
      // SMIL rotation — no rAF cost for the unassigned stations.
      spinner
        .append('animateTransform')
        .attr('attributeName', 'transform')
        .attr('type', 'rotate')
        .attr('from', '0')
        .attr('to', '360')
        .attr('dur', `${orbitSeconds(node) * 2.2}s`)
        .attr('repeatCount', 'indefinite');
    }
    const orbitRadius = radius(node) + 13;
    spinner
      .append('image')
      .attr('class', 'bs-station')
      .attr('href', `${assetRoot}/${STATION_SPRITES[hash(node.id) % STATION_SPRITES.length]}`)
      .attr('x', orbitRadius - 9)
      .attr('y', -9)
      .attr('width', 18)
      .attr('height', 18);
  }

  function drawPatrolShip(this: SVGGElement, worker: Worker): void {
    const body = select(this).append('g').attr('class', 'bs-worker-body');
    body
      .append('circle')
      .attr('class', 'bs-ship-hit')
      .attr('r', 13)
      .on('click', (event: MouseEvent) => startFollowing(event, worker));
    body
      .append('image')
      .attr('class', 'bs-ship')
      .attr('href', shipSprite(worker.targets[0]))
      .attr('x', -9)
      .attr('y', -9)
      .attr('width', 18)
      .attr('height', 18);
  }

  function syncWorkers(): void {
    const activeNodes = nodes.filter((node) => node.status === 'in_progress');
    const ownerGroups: Worker[] = [
      ...group(
        activeNodes.filter((node) => node.assignee),
        (node) => node.assignee as string,
      ),
    ].map(([owner, targets]) => ({
      owner,
      targets,
      color: ownerColor(targets[0]),
      phase: hash(owner) % 5000,
    }));
    const soloWorkers = ownerGroups.filter((worker) => worker.targets.length === 1);
    patrolWorkers = ownerGroups.filter((worker) => worker.targets.length > 1);
    const unassignedWorkers = activeNodes.filter((node) => !node.assignee);

    routeSelection = routeLayer
      .selectAll<SVGPathElement, Worker>('path.bs-patrol-route')
      .data(patrolWorkers, (worker) => worker.owner)
      .join('path')
      .attr('class', 'bs-patrol-route')
      .attr('data-owner', (worker) => worker.owner)
      .attr('stroke', (worker) => worker.color);

    trailSelection = trailLayer
      .selectAll<SVGGElement, Worker>('g.bs-patrol-trail-group')
      .data(patrolWorkers, (worker) => worker.owner)
      .join(
        (enter) => {
          const groups = enter.append('g').attr('class', 'bs-patrol-trail-group');
          groups.each(function addTrail(worker) {
            select(this)
              .selectAll('path')
              .data([
                { opacity: 0.08, width: 1.5 },
                { opacity: 0.32, width: 2.1 },
                { opacity: 0.82, width: 2.7 },
              ])
              .join('path')
              .attr('class', 'bs-patrol-trail')
              .attr('stroke', worker.color)
              .attr('stroke-opacity', (layer) => layer.opacity)
              .attr('stroke-width', (layer) => layer.width)
              .attr('filter', `url(#${shipGlowId})`);
          });
          return groups;
        },
        (update) => update,
        (exit) => exit.remove(),
      );

    orbitSelection = orbitLayer
      .selectAll<SVGGElement, Worker>('g.bs-orbit')
      .data(soloWorkers, (worker) => worker.owner)
      .join(
        (enter) => enter.append('g').attr('class', 'bs-orbit').each(drawOrbit),
        (update) => update,
        (exit) => exit.remove(),
      )
      .attr('data-owner', (worker) => worker.owner)
      .attr('aria-label', (worker) => `Follow ${worker.owner}`);

    stationSelection = stationLayer
      .selectAll<SVGGElement, SimNode>('g.bs-station-orbit')
      .data(unassignedWorkers, (node) => node.id)
      .join(
        (enter) => enter.append('g').attr('class', 'bs-station-orbit').each(drawStation),
        (update) => update,
        (exit) => exit.remove(),
      );

    patrolSelection = patrolLayer
      .selectAll<SVGGElement, Worker>('g.bs-patrol-worker')
      .data(patrolWorkers, (worker) => worker.owner)
      .join(
        (enter) => enter.append('g').attr('class', 'bs-patrol-worker').each(drawPatrolShip),
        (update) => update,
        (exit) => exit.remove(),
      )
      .attr('data-owner', (worker) => worker.owner)
      .attr('aria-label', (worker) => `Follow ${worker.owner}`);

    // An owner whose ship disappeared (work reassigned/finished) must not hold the camera.
    if (followedOwner && !ownerGroups.some((worker) => worker.owner === followedOwner)) {
      stopFollowing();
    }
  }

  function relationIds(): Set<string> {
    const related = new Set<string>();
    if (!selectedId) return related;
    related.add(selectedId);
    for (const link of links) {
      const source = endpointId(link.source);
      const target = endpointId(link.target);
      if (source === selectedId || target === selectedId) {
        related.add(source);
        related.add(target);
      }
    }
    return related;
  }

  function updateFocus(): void {
    const related = relationIds();
    nodeSelection
      .classed('dim', (node) => selectedId !== null && !related.has(node.id))
      .classed('selected', (node) => node.id === selectedId);
    linkSelection.classed('dim', (link) => {
      const source = endpointId(link.source);
      const target = endpointId(link.target);
      return selectedId !== null && source !== selectedId && target !== selectedId;
    });
  }

  function computeStats(): BeadStats {
    const active = nodes.filter((node) => node.status === 'in_progress');
    const owners = new Set(active.filter((node) => node.assignee).map((node) => node.assignee!));
    return {
      nodes: nodes.length,
      links: links.length,
      clusters: new Set(nodes.map((node) => node.cluster)).size,
      active: active.length,
      patrols: patrolWorkers.length,
      orbits: owners.size - patrolWorkers.length,
      stations: active.filter((node) => !node.assignee).length,
    };
  }

  // ── simulation ────────────────────────────────────────────────────────────────
  const simulation: Simulation<SimNode, SimLink> = forceSimulation<SimNode, SimLink>()
    // 0.6, not d3's 0.4 default: this field sits BEHIND a desktop whose windows
    // open/close constantly. At 0.42 each re-heat left ~58% of velocity carrying
    // into the next tick and the whole graph visibly oscillated ("vibrates
    // violently" — owner, 2026-08-09); higher decay makes any nudge die in well
    // under a second without changing the settled layout.
    .velocityDecay(0.6)
    .force(
      'link',
      forceLink<SimNode, SimLink>()
        .id((node) => node.id)
        .distance((link) => (link.kind === 'parent-child' ? 72 : 112))
        .strength((link) => (link.kind === 'parent-child' ? 0.76 : 0.34)),
    )
    .force('charge', forceManyBody().strength(-112))
    .force(
      'collide',
      forceCollide<SimNode>()
        .radius((node) => radius(node) + 22)
        .iterations(2),
    )
    .force('cluster-age', clusterRadialForce())
    .on('tick', () => {
      linkSelection
        .attr('x1', (link) => (link.source as SimNode).x)
        .attr('y1', (link) => (link.source as SimNode).y)
        .attr('x2', (link) => (link.target as SimNode).x)
        .attr('y2', (link) => (link.target as SimNode).y);
      nodeSelection.attr('transform', (node) => `translate(${node.x} ${node.y})`);
      orbitSelection.attr(
        'transform',
        (worker) => `translate(${worker.targets[0].x} ${worker.targets[0].y})`,
      );
      stationSelection.attr('transform', (node) => `translate(${node.x} ${node.y})`);
      routeSelection.attr('d', (worker) => geometry.patrolRoutePath(worker));
      if (!motionAllowed) {
        patrolSelection.attr('transform', (worker) => {
          const [x, y] = geometry.patrolWaypoints(worker)[0];
          return `translate(${x} ${y})`;
        });
      }
      // Keep the universe framed WHILE it settles, not just at the end. A big graph expands
      // for several seconds; waiting for 'end' leaves the user staring at a cropped blob,
      // and on a large dataset 'end' may be many seconds away.
      // O(n) over the nodes — negligible next to the force step, and doing it continuously
      // is what actually keeps a still-expanding layout inside the viewport.
      tickCount += 1;
      if (autoFit() && tickCount % 5 === 0) fitToContent(false);
    })
    .on('end', () => {
      if (autoFit()) fitToContent();
    });

  // ── data ingest ───────────────────────────────────────────────────────────────
  // Signature of the CURRENT node/link topology. A poll that returns the same
  // graph (only meta/status changed) must not re-heat the simulation: consumers
  // refresh on timers (universe-field polls every 1.2s), and re-heating on every
  // poll kept the field permanently mid-settle.
  let topologySignature = '';

  function ingest(next: BeadData, isFirst: boolean): void {
    const previous = new Map(nodes.map((node) => [node.id, node]));
    const bySize = clusterNamesBySize(next.nodes);
    // Caller-pinned names first (in their order), then anything else by size.
    clusterOrder = options.clusterOrder
      ? [
          ...options.clusterOrder.filter((name) => bySize.includes(name)),
          ...bySize.filter((name) => !options.clusterOrder!.includes(name)),
        ]
      : bySize;
    clusterAnchors = options.clusterAnchors ?? deriveClusterAnchors(clusterOrder);

    const degree = new Map<string, number>(next.nodes.map((node) => [node.id, 0]));
    const validIds = new Set(next.nodes.map((node) => node.id));
    // Drop links pointing at nodes the caller did not supply — d3-force would throw.
    const nextLinks = next.links.filter(
      (link) => validIds.has(link.source) && validIds.has(link.target),
    );
    for (const link of nextLinks) {
      degree.set(link.source, (degree.get(link.source) ?? 0) + 1);
      degree.set(link.target, (degree.get(link.target) ?? 0) + 1);
    }

    nodes = next.nodes.map((node) => {
      const existing = previous.get(node.id);
      const simNode: SimNode = {
        ...node,
        degree: degree.get(node.id) ?? 0,
        ageRadius: existing?.ageRadius ?? 0,
        // Carry position and velocity across updates so a refresh does not re-explode.
        x: existing?.x ?? 0,
        y: existing?.y ?? 0,
        vx: existing?.vx ?? 0,
        vy: existing?.vy ?? 0,
      };
      return simNode;
    });
    links = nextLinks.map((link) => ({ ...link }));

    assignAgeRadii();
    for (const node of nodes) {
      if (!previous.has(node.id)) seedPosition(node);
    }

    simulation.nodes(nodes);
    (simulation.force('link') as ReturnType<typeof forceLink>).links(links as never);
    syncLinks();
    syncNodes();
    syncWorkers();
    if (selectedId && !validIds.has(selectedId)) selectNode(null);
    updateFocus();
    // A first paint gets a full settle; a refresh whose TOPOLOGY changed gets a
    // small nudge; a same-graph refresh (status/meta only) gets none — positions
    // are already correct and a restart would only make the field twitch.
    const nextSignature =
      next.nodes.map((node) => node.id).sort().join('|') +
      '~' +
      nextLinks.map((link) => `${link.source}>${link.target}`).sort().join('|');
    const topologyChanged = isFirst || nextSignature !== topologySignature;
    topologySignature = nextSignature;
    if (topologyChanged) simulation.alpha(isFirst ? 1 : 0.15).restart();
    options.onStats?.(computeStats());
    if (!topologyChanged) return;

    /*
     * Frame the universe on a fixed schedule after ingest.
     *
     * This is deliberately NOT left to the simulation's own 'tick'/'end' hooks alone: those
     * were observed not to fire the fit in a real browser (proven live — an explicit fit()
     * at +6s moved the camera from scale(1) to scale(0.383), so the maths was right and the
     * trigger was wrong), and a graph that renders cropped off every edge with no indication
     * there is more is the single worst first impression this component can make.
     * Cheap, bounded, and cancelled on destroy.
     */
    for (const timer of fitTimers) window.clearTimeout(timer);
    fitTimers.length = 0;
    for (const delay of [350, 1200, 3000]) {
      fitTimers.push(
        window.setTimeout(() => {
          if (!destroyed && autoFit()) fitToContent(delay > 350);
        }, delay),
      );
    }
  }

  // ── animation ─────────────────────────────────────────────────────────────────
  function animateShips(now: number): void {
    if (destroyed) return;
    routeSelection.attr('d', (worker) => geometry.patrolRoutePath(worker));

    orbitSelection.each(function moveOrbit(worker) {
      const node = worker.targets[0];
      const duration = orbitSeconds(node) * 1000;
      const angle = (((now + worker.phase) % duration) / duration) * Math.PI * 2;
      select(this)
        .select('.bs-orbit-spinner')
        .attr('transform', `rotate(${(angle * 180) / Math.PI})`);
      if (followedOwner === worker.owner) {
        const orbitRadius = radius(node) + 11;
        followCamera(node.x + Math.cos(angle) * orbitRadius, node.y + Math.sin(angle) * orbitRadius);
      }
    });

    const trailNodes = trailSelection.nodes();
    patrolSelection.each(function movePatrol(worker, index) {
      const pose = geometry.patrolPose(worker, now);
      worker.trail ??= [];
      // Index rather than `.at(-1)`: consumers compile this source under THEIR tsconfig, and
      // `Array.prototype.at` needs lib ES2022. awkit targets ES2020, so `.at()` made the
      // package uncompilable for its own consumers.
      const previous = worker.trail[worker.trail.length - 1];
      if (!previous || Math.hypot(pose.x - previous[0], pose.y - previous[1]) >= 1.5) {
        worker.trail.push([pose.x, pose.y]);
        if (worker.trail.length > 230) worker.trail.shift();
      }

      const trailGroup = trailNodes[index];
      if (trailGroup) {
        const segments = trailSegments(worker.trail);
        select(trailGroup)
          .selectAll('path')
          .attr('d', (_, layerIndex) => {
            const segment = segments[layerIndex];
            return segment && segment.length > 1 ? trailCurve(segment) : null;
          });
      }

      select(this)
        .attr('transform', `translate(${pose.x} ${pose.y})`)
        .select('.bs-worker-body')
        .attr('transform', `rotate(${pose.direction})`);
      if (followedOwner === worker.owner) followCamera(pose.x, pose.y);
    });

    frame = window.requestAnimationFrame(animateShips);
  }

  // ── wiring ────────────────────────────────────────────────────────────────────
  function reset(): void {
    stopFollowing();
    selectNode(null);
    svg
      .transition()
      .duration(motionAllowed ? 450 : 0)
      .call(zoom.transform as never, homeTransform);
  }

  svg.on('click', reset);
  followButton.addEventListener('click', reset);

  /*
   * Auto-fit yields the moment the user actually touches the camera.
   *
   * This is bound to real input events rather than d3-zoom's `event.sourceEvent`, because
   * that fires for PROGRAMMATIC transforms too — including auto-fit's own — so auto-fit was
   * marking the camera as user-moved on its very first application and then permanently
   * disabling itself. That is why both the tick and timer triggers appeared dead.
   */
  const claimCamera = () => {
    userMovedCamera = true;
  };
  svgElement.addEventListener('wheel', claimCamera, { passive: true });
  svgElement.addEventListener('mousedown', claimCamera);
  svgElement.addEventListener('touchstart', claimCamera, { passive: true });

  measure();
  drawStarfield();
  svg.call(zoom);
  svg.call(zoom.transform, homeTransform);
  ingest(data, true);
  if (motionAllowed) frame = window.requestAnimationFrame(animateShips);

  // Debounced: the OS desktop animates window/stage transitions (~500ms of
  // continuous container resizes), and reacting to every frame re-heated the
  // simulation dozens of times per interaction — the reported "vibrates
  // violently on every click". One settle after the dust clears is enough.
  let resizeTimer: number | null = null;
  const observer =
    typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          if (destroyed) return;
          if (resizeTimer !== null) window.clearTimeout(resizeTimer);
          resizeTimer = window.setTimeout(() => {
            resizeTimer = null;
            if (!destroyed) handleResize();
          }, 200);
        })
      : null;
  observer?.observe(container);

  function handleResize(): void {
    const previousWidth = width;
    const previousHeight = height;
    measure();
    if (width === previousWidth && height === previousHeight) return;
    drawStarfield();
    // Sub-48px deltas are chrome/transition jitter, not a real reshape: keep the
    // new measurements and starfield, but leave the layout and camera alone.
    const delta = Math.max(
      Math.abs(width - previousWidth),
      Math.abs(height - previousHeight),
    );
    if (delta < 48) return;
    assignAgeRadii();
    // Let the cluster force re-settle into the new box rather than teleporting nodes.
    simulation.alpha(Math.max(simulation.alpha(), 0.3)).restart();
    if (!followedOwner) svg.call(zoom.transform, homeTransform);
  }

  return {
    update(next: BeadData) {
      if (destroyed) return;
      ingest(next, false);
    },
    select(id: string | null) {
      if (destroyed) return;
      selectNode(id ? (nodes.find((node) => node.id === id) ?? null) : null);
    },
    follow(owner: string | null) {
      if (destroyed) return;
      if (owner === null) {
        stopFollowing();
        return;
      }
      const worker = [...patrolWorkers, ...orbitSelection.data()].find(
        (candidate) => candidate.owner === owner,
      );
      if (worker) startFollowing(new Event('follow'), worker);
    },
    reset,
    fit: () => {
      userMovedCamera = false;
      // Immediate, not animated: an explicit API call must take effect synchronously.
      // Animating here meant `fit()` did nothing until a transition timer fired, which is
      // both surprising for callers and untestable.
      fitToContent(false);
    },
    clusters: () =>
      clusterOrder.map((name, index) => ({
        name,
        color: clusterPalette[index % clusterPalette.length],
        count: nodes.filter((node) => node.cluster === name).length,
      })),
    resize: handleResize,
    stats: computeStats,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
      for (const timer of fitTimers) window.clearTimeout(timer);
      fitTimers.length = 0;
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = null;
      observer?.disconnect();
      simulation.on('tick', null);
      simulation.stop();
      svg.on('.zoom', null);
      svg.on('click', null);
      root.remove();
    },
  };
}
