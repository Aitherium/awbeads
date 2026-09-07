/**
 * Flight-path and orbit mathematics.
 *
 * Ported essentially verbatim from upstream bead-space `src/main.js` (MIT — see NOTICE.md).
 * The only structural change: upstream these were module-scope functions closing over the
 * module-scope `nodes` array, `radius()`, `orbitSeconds()` and `simulation`. Here they are
 * built by `createGeometry(deps)` so multiple universes can coexist on one page.
 */
import { max as d3max, min as d3min, pairs, sum } from 'd3-array';

import { hash } from './hash';
import type { CubicSegment, SimNode, Worker } from '../types';

export interface GeometryDeps {
  /** Live view of the simulation's nodes — read on every call, never cached. */
  getNodes: () => SimNode[];
  radius: (node: SimNode) => number;
  orbitSeconds: (node: SimNode) => number;
  /** Current simulation alpha; below 0.06 the layout is settled and routes are locked. */
  getAlpha: () => number;
}

export interface Geometry {
  patrolWaypoints(worker: Worker): Array<[number, number]>;
  patrolGeometry(worker: Worker): NonNullable<Worker['geometry']>;
  patrolRoutePath(worker: Worker): string;
  patrolPose(worker: Worker, now: number): { x: number; y: number; direction: number };
  trailSegments(points: Array<[number, number]>): Array<Array<[number, number]>>;
  arcPath(orbitRadius: number, startDegrees: number, endDegrees: number): string;
}

export function arcPath(orbitRadius: number, startDegrees: number, endDegrees: number): string {
  const start = (startDegrees * Math.PI) / 180;
  const end = (endDegrees * Math.PI) / 180;
  const startX = Math.cos(start) * orbitRadius;
  const startY = Math.sin(start) * orbitRadius;
  const endX = Math.cos(end) * orbitRadius;
  const endY = Math.sin(end) * orbitRadius;
  return `M ${startX} ${startY} A ${orbitRadius} ${orbitRadius} 0 0 1 ${endX} ${endY}`;
}

export function cubicPoint(segment: CubicSegment, progress: number): [number, number] {
  const [from, controlOne, controlTwo, to] = segment;
  const inverse = 1 - progress;
  return [
    inverse ** 3 * from[0] +
      3 * inverse ** 2 * progress * controlOne[0] +
      3 * inverse * progress ** 2 * controlTwo[0] +
      progress ** 3 * to[0],
    inverse ** 3 * from[1] +
      3 * inverse ** 2 * progress * controlOne[1] +
      3 * inverse * progress ** 2 * controlTwo[1] +
      progress ** 3 * to[1],
  ];
}

export function cubicVelocity(segment: CubicSegment, progress: number): [number, number] {
  const [from, controlOne, controlTwo, to] = segment;
  const inverse = 1 - progress;
  return [
    3 * inverse ** 2 * (controlOne[0] - from[0]) +
      6 * inverse * progress * (controlTwo[0] - controlOne[0]) +
      3 * progress ** 2 * (to[0] - controlTwo[0]),
    3 * inverse ** 2 * (controlOne[1] - from[1]) +
      6 * inverse * progress * (controlTwo[1] - controlOne[1]) +
      3 * progress ** 2 * (to[1] - controlTwo[1]),
  ];
}

export function trailSegments(
  points: Array<[number, number]>,
): Array<Array<[number, number]>> {
  if (points.length < 2) return [[], [], []];
  const firstCut = Math.max(1, Math.floor(points.length * 0.45));
  const secondCut = Math.max(firstCut + 1, Math.floor(points.length * 0.74));
  return [
    points.slice(0, firstCut + 1),
    points.slice(firstCut, secondCut + 1),
    points.slice(secondCut),
  ];
}

export function createGeometry(deps: GeometryDeps): Geometry {
  const { getNodes, radius, orbitSeconds, getAlpha } = deps;

  function patrolWaypoints(worker: Worker): Array<[number, number]> {
    return worker.targets.map((node) => {
      const angle = ((hash(`${worker.owner}:${node.id}`) % 360) * Math.PI) / 180;
      const clearance = radius(node) + 27;
      return [node.x + Math.cos(angle) * clearance, node.y + Math.sin(angle) * clearance];
    });
  }

  /**
   * Smallest signed gap between a candidate route and any planet's surface (+20px margin).
   * Negative means the route clips a planet — that candidate is rejected.
   */
  function routeClearance(segments: CubicSegment[]): number {
    const nodes = getNodes();
    let minimum = Number.POSITIVE_INFINITY;
    for (const segment of segments) {
      const controlLength = sum(pairs(segment), ([from, to]) =>
        Math.hypot(to[0] - from[0], to[1] - from[1]),
      );
      const steps = Math.min(120, Math.max(20, Math.ceil(controlLength / 9)));
      for (let step = 0; step <= steps; step += 1) {
        const [x, y] = cubicPoint(segment, step / steps);
        for (const node of nodes) {
          minimum = Math.min(minimum, Math.hypot(x - node.x, y - node.y) - radius(node) - 20);
        }
      }
    }
    return minimum;
  }

  function smoothRoute(
    points: Array<[number, number]>,
    startTangent: [number, number],
    endTangent: [number, number],
  ): CubicSegment[] {
    const tangents = points.map((point, index) => {
      if (index === 0) return startTangent;
      if (index === points.length - 1) return endTangent;
      const previous = points[index - 1];
      const next = points[index + 1];
      const distance = Math.hypot(next[0] - previous[0], next[1] - previous[1]) || 1;
      return [(next[0] - previous[0]) / distance, (next[1] - previous[1]) / distance] as [
        number,
        number,
      ];
    });
    return pairs(points).map(([from, to], index) => {
      const distance = Math.hypot(to[0] - from[0], to[1] - from[1]);
      const handle = Math.min(88, Math.max(20, distance * 0.28));
      return [
        from,
        [from[0] + tangents[index][0] * handle, from[1] + tangents[index][1] * handle],
        [to[0] - tangents[index + 1][0] * handle, to[1] - tangents[index + 1][1] * handle],
        to,
      ] as CubicSegment;
    });
  }

  /**
   * One leg of a patrol: leave planet `index` tangentially, arrive at the next planet
   * tangentially, routing around anything in between. Tries a straight tangent-to-tangent
   * curve first, then progressively wider lateral detours, then four perimeter routes;
   * falls back to whichever candidate had the most clearance.
   */
  function flightCurve(
    worker: Worker,
    index: number,
    waypoints: Array<[number, number]> = patrolWaypoints(worker),
  ): CubicSegment[] {
    const nodes = getNodes();
    const node = worker.targets[index];
    const nextNode = worker.targets[(index + 1) % worker.targets.length];
    const from = waypoints[index];
    const to = waypoints[(index + 1) % waypoints.length];
    const fromAngle = Math.atan2(from[1] - node.y, from[0] - node.x);
    const toAngle = Math.atan2(to[1] - nextNode.y, to[0] - nextNode.x);
    const tangentFrom: [number, number] = [-Math.sin(fromAngle), Math.cos(fromAngle)];
    const tangentTo: [number, number] = [-Math.sin(toAngle), Math.cos(toAngle)];
    const deltaX = to[0] - from[0];
    const deltaY = to[1] - from[1];
    const distance = Math.hypot(deltaX, deltaY) || 1;
    const line = [deltaX / distance, deltaY / distance];
    const normal = [-line[1], line[0]];
    const handle = Math.min(82, Math.max(22, distance * 0.15));
    const preferredSign = hash(`${worker.owner}:${node.id}:route`) % 2 ? 1 : -1;
    const offsets = [0, 90, -90, 180, -180, 300, -300, 450, -450, 650, -650, 900, -900].map(
      (offset) => offset * preferredSign,
    );
    let best: { segments: CubicSegment[]; clearance: number } | null = null;

    for (const offset of offsets) {
      let segments: CubicSegment[];
      if (offset === 0) {
        segments = [
          [
            from,
            [from[0] + tangentFrom[0] * handle, from[1] + tangentFrom[1] * handle],
            [to[0] - tangentTo[0] * handle, to[1] - tangentTo[1] * handle],
            to,
          ],
        ];
      } else {
        const middle: [number, number] = [
          (from[0] + to[0]) / 2 + normal[0] * offset,
          (from[1] + to[1]) / 2 + normal[1] * offset,
        ];
        const middleHandle = Math.min(70, handle * 0.72);
        segments = [
          [
            from,
            [from[0] + tangentFrom[0] * handle, from[1] + tangentFrom[1] * handle],
            [middle[0] - line[0] * middleHandle, middle[1] - line[1] * middleHandle],
            middle,
          ],
          [
            middle,
            [middle[0] + line[0] * middleHandle, middle[1] + line[1] * middleHandle],
            [to[0] - tangentTo[0] * handle, to[1] - tangentTo[1] * handle],
            to,
          ],
        ];
      }
      const clearance = routeClearance(segments);
      if (!best || clearance > best.clearance) best = { segments, clearance };
      if (clearance >= 0) return segments;
    }

    const bounds = {
      left: (d3min(nodes, (candidate) => candidate.x - radius(candidate)) ?? 0) - 90,
      right: (d3max(nodes, (candidate) => candidate.x + radius(candidate)) ?? 0) + 90,
      top: (d3min(nodes, (candidate) => candidate.y - radius(candidate)) ?? 0) - 90,
      bottom: (d3max(nodes, (candidate) => candidate.y + radius(candidate)) ?? 0) + 90,
    };
    const perimeterRoutes: Array<Array<[number, number]>> = [
      [from, [from[0], bounds.top], [to[0], bounds.top], to],
      [from, [from[0], bounds.bottom], [to[0], bounds.bottom], to],
      [from, [bounds.left, from[1]], [bounds.left, to[1]], to],
      [from, [bounds.right, from[1]], [bounds.right, to[1]], to],
    ];
    for (const points of perimeterRoutes) {
      const segments = smoothRoute(points, tangentFrom, tangentTo);
      const clearance = routeClearance(segments);
      if (!best || clearance > best.clearance) best = { segments, clearance };
      if (clearance >= 0) return segments;
    }
    return best!.segments;
  }

  /**
   * Route geometry is expensive (clearance sampling is O(steps × nodes) per candidate), so it
   * is memoised on the worker against a quantised position signature, rate-limited to 1.2s,
   * and permanently locked once the layout settles.
   */
  function patrolGeometry(worker: Worker): NonNullable<Worker['geometry']> {
    const signature = worker.targets
      .map((node) => `${Math.round(node.x / 8)},${Math.round(node.y / 8)},${radius(node)}`)
      .join('|');
    if (worker.geometry?.locked) return worker.geometry;
    if (worker.geometry?.signature === signature) {
      if (getAlpha() < 0.06) worker.geometry.locked = true;
      return worker.geometry;
    }
    const now = performance.now();
    if (worker.geometry && now - worker.geometry.computedAt < 1200) return worker.geometry;
    const waypoints = patrolWaypoints(worker);
    const curves = worker.targets.map((_, index) => flightCurve(worker, index, waypoints));
    worker.geometry = {
      signature,
      waypoints,
      curves,
      computedAt: now,
      locked: getAlpha() < 0.06,
    };
    return worker.geometry;
  }

  function patrolRoutePath(worker: Worker): string {
    return patrolGeometry(worker)
      .curves.flat()
      .map(
        ([from, controlOne, controlTwo, to]) =>
          `M ${from[0]} ${from[1]} C ${controlOne[0]} ${controlOne[1]} ${controlTwo[0]} ${controlTwo[1]} ${to[0]} ${to[1]}`,
      )
      .join(' ');
  }

  /**
   * Where a patrolling ship is at time `now`: one full orbit at each assignment, then a
   * flight along the routed curve to the next. Older assignments orbit slower.
   */
  function patrolPose(worker: Worker, now: number) {
    const { waypoints, curves } = patrolGeometry(worker);
    const legs = worker.targets.map((node, index) => {
      const from = waypoints[index];
      const to = waypoints[(index + 1) % waypoints.length];
      const distance = Math.hypot(to[0] - from[0], to[1] - from[1]);
      const orbitDuration = orbitSeconds(node) * 1000;
      const flightDuration = Math.max(1800, distance * (12 + orbitSeconds(node) * 1.15));
      return {
        node,
        from,
        to,
        curve: curves[index],
        orbitDuration,
        flightDuration,
        duration: orbitDuration + flightDuration,
      };
    });
    const cycleDuration = sum(legs, (leg: { duration: number }) => leg.duration);
    let elapsed = (now + worker.phase) % cycleDuration;
    let leg = legs[0];
    for (const candidate of legs) {
      leg = candidate;
      if (elapsed <= candidate.duration) break;
      elapsed -= candidate.duration;
    }

    const centerAngle = Math.atan2(leg.from[1] - leg.node.y, leg.from[0] - leg.node.x);
    const orbitRadius = radius(leg.node) + 27;
    if (elapsed <= leg.orbitDuration) {
      const progress = elapsed / leg.orbitDuration;
      const angle = centerAngle + progress * Math.PI * 2;
      return {
        x: leg.node.x + Math.cos(angle) * orbitRadius,
        y: leg.node.y + Math.sin(angle) * orbitRadius,
        direction: (angle * 180) / Math.PI + 180,
      };
    }

    const flightProgress = Math.min(1, (elapsed - leg.orbitDuration) / leg.flightDuration);
    const scaledProgress = flightProgress * leg.curve.length;
    const segmentIndex = Math.min(leg.curve.length - 1, Math.floor(scaledProgress));
    const segmentProgress = Math.min(1, scaledProgress - segmentIndex);
    const [x, y] = cubicPoint(leg.curve[segmentIndex], segmentProgress);
    const [velocityX, velocityY] = cubicVelocity(leg.curve[segmentIndex], segmentProgress);
    return {
      x,
      y,
      direction: (Math.atan2(velocityY, velocityX) * 180) / Math.PI + 90,
    };
  }

  return { patrolWaypoints, patrolGeometry, patrolRoutePath, patrolPose, trailSegments, arcPath };
}
