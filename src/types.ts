/**
 * Data contract for the bead-space universe.
 *
 * Deliberately tiny — every AitherOS adapter (work graph, fleet topology, codegraph,
 * memory graph) normalises down to exactly this shape. See `src/adapters/`.
 */

/** Canonical lifecycle vocabulary the renderer understands. */
export type BeadStatus = 'open' | 'in_progress' | 'blocked' | 'deferred' | 'done';

/** Relationship kinds. `parent-child` is solid; the other two render dashed. */
export type BeadLinkKind = 'parent-child' | 'blocks' | 'related';

export interface BeadNode {
  /** Stable unique id. Rendered as the tooltip heading. */
  id: string;
  /** Human label. */
  title: string;
  /**
   * Grouping key — each distinct cluster becomes its own constellation with its own
   * anchor point, so independent work streams do not collapse into one blob.
   */
  cluster: string;
  status: BeadStatus;
  /** Owner currently working this node. Drives ship spawning and planet tint. */
  assignee?: string | null;
  /** ISO timestamp. Radial distance from the cluster core encodes this (older = inner). */
  createdAt: string;
  /** ISO timestamp the node entered its current status. Drives orbit speed. */
  stateStartedAt?: string | null;
  /** Optional deep link; the host decides what to do with it via `onSelect`. */
  href?: string;
  /** Adapter-specific passthrough (severity, health, port, module path, …). */
  meta?: Record<string, unknown>;
}

export interface BeadLink {
  source: string;
  target: string;
  kind: BeadLinkKind;
}

export interface BeadData {
  nodes: BeadNode[];
  links: BeadLink[];
}

/** Live counts, emitted on every data change so the host can render its own chrome. */
export interface BeadStats {
  nodes: number;
  links: number;
  clusters: number;
  active: number;
  /** Owners spread across >1 active node (they get a patrolling ship). */
  patrols: number;
  /** Owners on exactly one active node (they get an orbiting ship). */
  orbits: number;
  /** Active but unassigned nodes (they get a slow station). */
  stations: number;
}

export interface BeadSpaceOptions {
  /**
   * Where the sprite PNGs live, no trailing slash. Defaults to `/assets/kenney-simple-space`.
   * Next.js hosts should copy `assets/kenney-simple-space/` into `public/`.
   */
  assetRoot?: string;
  /** Colour cycle assigned to owners by stable hash. */
  ownerPalette?: string[];
  /**
   * Colour cycle for planets that have NO owner, assigned by cluster in size order.
   * Without this a universe of unowned nodes (debt rows, services, modules) renders as
   * hundreds of identical white dots.
   */
  clusterPalette?: string[];
  /**
   * Pin the cluster→colour assignment order. REQUIRED for ordinal clusters (severity,
   * priority, layer): the default order is by cluster size, which for a debt ledger paints
   * the biggest bucket with the most alarming colour rather than the most severe one.
   * Names not listed here fall in afterwards, by size.
   */
  clusterOrder?: string[];
  /**
   * Zoom the camera to fit the whole universe once the layout settles, instead of sitting at
   * scale 1 while the graph spills off every edge. Default true.
   */
  fitToContent?: boolean;
  /**
   * Explicit cluster anchor points as normalised `[x, y]` in `0..1`. Omit to derive
   * anchors automatically — clusters are laid out on a ring, largest first.
   */
  clusterAnchors?: Record<string, [number, number]>;
  /** Render the parallax starfield. Default true. */
  starfield?: boolean;
  /**
   * Text drawn under each planet. Default: `title`, truncated.
   * Return an empty string to omit a label for that node.
   */
  nodeLabel?: (node: BeadNode) => string;
  /**
   * Labels are hidden on a crowded map and appear once you zoom past this scale, so a
   * 500-node universe stays legible instead of turning into a wall of text. Default 1.6.
   */
  labelZoom?: number;
  /**
   * …but a small universe should just be readable immediately. At or below this node
   * count labels are always on. Default 60.
   */
  labelsAlwaysBelow?: number;
  /**
   * Force-disable animation. Defaults to honouring `prefers-reduced-motion`.
   * When motion is off, ships are pinned at their first waypoint (still legible, no rAF loop).
   */
  reducedMotion?: boolean;
  /** Fired when a planet is selected (click / Enter / Space), or `null` on reset. */
  onSelect?: (node: BeadNode | null) => void;
  /** Fired when a ship is followed by the camera, or `null` when following stops. */
  onFollow?: (owner: string | null) => void;
  /** Fired whenever the dataset changes, so the host can render a summary line. */
  onStats?: (stats: BeadStats) => void;
}

export interface BeadSpaceHandle {
  /** Replace the dataset. Existing nodes keep their positions; the sim restarts gently. */
  update(data: BeadData): void;
  /** Programmatically select a node (or clear with `null`). */
  select(id: string | null): void;
  /** Programmatically follow an owner's ship (or stop with `null`). */
  follow(owner: string | null): void;
  /** Reset selection, following and camera to home. */
  reset(): void;
  /** Zoom the camera to frame the whole universe. */
  fit(): void;
  /** Clusters in render order with their assigned tint — for drawing a legend. */
  clusters(): Array<{ name: string; color: string; count: number }>;
  /** Re-measure the container. Called automatically by a ResizeObserver. */
  resize(): void;
  stats(): BeadStats;
  /** Tear down the rAF loop, the simulation, the observer and all DOM. */
  destroy(): void;
}

/** Internal — a node once the simulation has given it coordinates. */
export interface SimNode extends BeadNode {
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
  degree: number;
  ageRadius: number;
}

/** Internal — one owner and the active nodes they hold. */
export interface Worker {
  owner: string;
  targets: SimNode[];
  color: string;
  phase: number;
  trail?: Array<[number, number]>;
  geometry?: {
    signature: string;
    waypoints: Array<[number, number]>;
    curves: CubicSegment[][];
    computedAt: number;
    locked: boolean;
  };
}

/** `[from, controlOne, controlTwo, to]` */
export type CubicSegment = [
  [number, number],
  [number, number],
  [number, number],
  [number, number],
];
