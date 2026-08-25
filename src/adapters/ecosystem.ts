/**
 * The wider Aither World — the PUBLIC ecosystem, rendered around AitherOS itself.
 *
 * Every other adapter in this directory describes the inside of the platform:
 * the agent roster, the fleet, the work graph, the mesh. This one describes what
 * is outside it and adoptable by a stranger — the aw* bricks, each of which
 * installs on its own, works offline, and needs no account.
 *
 * It reads the same registry every other ecosystem surface reads
 * (`AitherOS/config/ecosystem.yaml`, via each repo's published
 * `aither-manifest.json`), so the desktop background cannot drift from the
 * constellation widget, the estate strip, or the README tables. That mattered:
 * before those were generated, five hand-kept copies of this same list
 * disagreed, and two of them advertised repos that had been renamed away.
 *
 * WHY EACH BRICK GETS ITS OWN CLUSTER RING RATHER THAN ONE BLOB. `cluster` is
 * what the renderer anchors a constellation to, so grouping by `kind` puts the
 * base (awnix), the runtimes, the tools and the corpora in separate orbits —
 * which is the actual shape of the family, and the reason `adopt:` may not name
 * a sibling. One "ecosystem" cluster would render the family as a single lump
 * and lose exactly the property the family is organised around.
 */

import type { BeadData, BeadLink, BeadNode, BeadStatus } from '../types';

/** One brick, as the registry and every published manifest describe it. */
export interface EcosystemBrickRecord {
  id: string;
  /** Registry status: public | no-pages | unpublished | planned | merged. */
  status?: string | null;
  kind?: string | null;
  tagline?: string | null;
  description?: string | null;
  adopt?: string | null;
  /** Composition, never dependency — see EC003. Rendered dashed. */
  pairs_with?: string[] | null;
  /** Containment. Rendered solid. */
  includes?: string[] | null;
  url?: string | null;
  repository?: string | null;
}

/**
 * One pack on the public shelf (`awpack/packs/<id>/pack.yaml`).
 *
 * Deliberately NOT an `EcosystemBrickRecord`. A brick installs on its own; a
 * pack runs inside a runtime, so it carries `runtime` where a brick carries
 * `kind`, and it can never satisfy the lego rule that makes something a brick.
 * Modelling it as a brick with a funny kind would put it in a sibling orbit and
 * quietly assert it is independently adoptable.
 */
export interface EcosystemPackRecord {
  id: string;
  /** Shelf status: published | preview | internal. */
  status?: string | null;
  summary?: string | null;
  /** The runtime it runs inside, e.g. `awdk>=3.8.0`. */
  runtime?: string | null;
  /** The command a reader types. Declared by the pack, never inferred. */
  install?: string | null;
  tools?: string[] | null;
}

export interface EcosystemOptions {
  /**
   * Include bricks that have no public repo yet. Default false: the desktop
   * background is a map of what a visitor can go and get.
   *
   * `planned` is a real, deliberate state in this registry rather than an
   * omission (awnet was re-forgotten every time anyone listed the family until
   * it was registered while still absent), so it is renderable on request —
   * just not by default.
   */
  includeUnbuilt?: boolean;
  /**
   * Packs on the shelf, rendered in their own orbit and linked INTO the
   * runtime they need. Empty by default: a caller that knows nothing about
   * packs must keep rendering exactly the graph it rendered before.
   */
  packs?: EcosystemPackRecord[];
  /**
   * Where the public shelf serves, e.g.
   * `https://github.com/Aitherium/awpack/tree/main/packs`. Omitted by default
   * ON PURPOSE: the shelf is not public yet, and a node that looks clickable
   * and 404s is worse than one that does not.
   */
  shelfBaseUrl?: string;
  /** Cluster prefix, so these orbits read as one family in a mixed universe. */
  clusterPrefix?: string;
}

/**
 * Registry status -> lifecycle vocabulary.
 *
 * Deliberately NOT all `done`. The renderer encodes status as motion and tint,
 * so flattening the family to one state would throw away the most interesting
 * thing the registry knows: a brick with a repo but no site is genuinely further
 * along than one that is only named, and both are further than nothing.
 */
const STATUS: Record<string, BeadStatus> = {
  public: 'done',
  'no-pages': 'in_progress',
  unpublished: 'open',
  planned: 'open',
  merged: 'deferred',
};

/** Bricks a stranger can actually go and get. */
const SHIPPED = new Set(['public', 'no-pages']);

/**
 * Radial distance encodes age, and the registry has no timestamps. Rather than
 * inventing dates, order is derived from how far along a brick is and then from
 * its position in the registry — so the shipped, adoptable bricks sit toward the
 * core and the merely-named ones drift outward, which is the reading a viewer
 * would take from the picture anyway.
 */
function syntheticCreatedAt(index: number, total: number): string {
  const span = 1000 * 60 * 60 * 24 * 365;
  const t = Date.now() - span + Math.round((index / Math.max(total, 1)) * span);
  return new Date(t).toISOString();
}

export function fromEcosystem(
  bricks: EcosystemBrickRecord[],
  options: EcosystemOptions = {},
): BeadData {
  const prefix = options.clusterPrefix ?? 'aither world';
  const visible = bricks.filter((b) => {
    const status = (b.status ?? '').toLowerCase();
    return options.includeUnbuilt ? status !== 'merged' : SHIPPED.has(status);
  });

  // Shipped first, so the adoptable bricks anchor the inner orbits.
  const ordered = [...visible].sort((a, b) => {
    const rank = (x: EcosystemBrickRecord) =>
      SHIPPED.has((x.status ?? '').toLowerCase()) ? 0 : 1;
    return rank(a) - rank(b);
  });

  const nodes: BeadNode[] = ordered.map((brick, index) => {
    const status = (brick.status ?? '').toLowerCase();
    const kind = (brick.kind ?? 'tool').toLowerCase();
    return {
      id: `aw:${brick.id}`,
      title: brick.id,
      cluster: `${prefix} · ${kind}`,
      status: STATUS[status] ?? 'open',
      assignee: null,
      createdAt: syntheticCreatedAt(index, ordered.length),
      stateStartedAt: null,
      // Only a brick that actually serves gets a link. A dead href on a
      // background nobody expects to be clickable is worse than none.
      // Derived when absent: the registry carries no url, but a published
      // brick's page is `<pages>/<id>/` by construction — that is exactly how
      // every aither-manifest.json is generated, so deriving it here keeps the
      // desktop and the manifests from disagreeing about where a brick lives.
      href: status === 'public'
        ? brick.url ?? `https://aitherium.github.io/${brick.id}/`
        : undefined,
      meta: {
        kind,
        rawStatus: status,
        tagline: brick.tagline ?? brick.description ?? '',
        adopt: brick.adopt ?? '',
        repository: brick.repository ?? '',
        ecosystem: true,
      },
    };
  });

  // Packs, in their own orbit. Pushed onto `nodes` BEFORE the known-set is
  // built, so a pack -> runtime link is validated by the same guard every other
  // link is: a link to an absent node draws a line into empty space, which
  // reads as a rendering fault rather than as missing data.
  const packs = (options.packs ?? []).filter(
    (pk) => (pk.status ?? '').toLowerCase() !== 'internal',
  );
  for (const [index, pk] of packs.entries()) {
    const status = (pk.status ?? '').toLowerCase();
    nodes.push({
      id: `awpack:${pk.id}`,
      title: pk.id,
      cluster: `${prefix} · pack`,
      status: STATUS[status] ?? 'open',
      assignee: null,
      createdAt: syntheticCreatedAt(index, Math.max(packs.length, 1)),
      stateStartedAt: null,
      // Only when the caller says the shelf is actually reachable. This file
      // already applies that rule to bricks -- "Only a brick that actually
      // serves gets a link. A dead href on a background nobody expects to be
      // clickable is worse than none" -- and the first version of this line
      // ignored it, hardcoding a URL into a repo that is still private:
      // github.com/Aitherium/awpack/tree/main/packs/gobbonet answered 404.
      href: options.shelfBaseUrl ? `${options.shelfBaseUrl}/${pk.id}` : undefined,
      meta: {
        kind: 'pack',
        rawStatus: status,
        tagline: pk.summary ?? '',
        adopt: pk.install ?? '',
        runtime: pk.runtime ?? '',
        tools: (pk.tools ?? []).join(', '),
        ecosystem: true,
      },
    });
  }

  const known = new Set(nodes.map((n) => n.id));
  const links: BeadLink[] = [];

  // runtime -> pack, solid, because it is CONTAINMENT and not composition. The
  // runtime string is a requirement spec (`awdk>=3.8.0`), so the brick id is
  // its leading name; anything else would need the registry to agree about
  // version syntax, which is not this adapter's job.
  for (const pk of packs) {
    const host = (pk.runtime ?? '').trim().split(/[\s<>=!~,;[]/)[0];
    if (!host) continue;
    const source = `aw:${host}`;
    const target = `awpack:${pk.id}`;
    if (!nodes.some((n) => n.id === source)) continue;
    links.push({ source, target, kind: 'parent-child' });
  }
  const seen = new Set<string>();

  const add = (from: string, to: string, kind: BeadLink['kind']) => {
    const source = `aw:${from}`;
    const target = `aw:${to}`;
    // A brick may pair with one that is filtered out of this view, or with one
    // that does not exist yet. Emitting a link to an absent node would leave a
    // line reaching into empty space, which reads as a rendering fault.
    if (!known.has(source) || !known.has(target) || source === target) return;
    // `pairs_with` is symmetric and both sides declare it; without this the
    // family renders every composition twice and the graph looks denser than
    // the registry actually says it is.
    const key = kind === 'related'
      ? [source, target].sort().join('\0') + kind
      : `${source}\0${target}${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ source, target, kind });
  };

  for (const brick of ordered) {
    for (const other of brick.includes ?? []) add(brick.id, other, 'parent-child');
    for (const other of brick.pairs_with ?? []) add(brick.id, other, 'related');
  }

  return { nodes, links };
}

/**
 * Merge the ecosystem into an existing universe (the AitherOS interior).
 *
 * Ids are namespaced `aw:` so a brick and a service of the same name cannot
 * collide — `awrelay` the public brick and the internal relay service are
 * different things, and silently unifying them would be the same category error
 * as pointing a mirror lane from one package at another of the same name.
 */
export function withEcosystem(inner: BeadData, ecosystem: BeadData): BeadData {
  const ids = new Set(inner.nodes.map((n) => n.id));
  return {
    nodes: [...inner.nodes, ...ecosystem.nodes.filter((n) => !ids.has(n.id))],
    links: [...inner.links, ...ecosystem.links],
  };
}
