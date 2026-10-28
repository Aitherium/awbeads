/**
 * ShadowBroker adapter — the OSINT intercept board as a universe.
 *
 * ShadowBroker (wizzense/Shadowbroker) aggregates public telemetry (aircraft,
 * ships, satellites, conflict, cyber) and exposes it to agents through an HMAC
 * command channel. The history desk already reads `search_news` from it; this
 * adapter paints the same records so the board's live evidence can sit next to
 * the work graph in BeadSpace instead of in a separate tab.
 *
 * Mapping, deliberately literal:
 *   - one root planet: the board itself (`sb:board`);
 *   - one planet per event, clustered by its source layer (news / GDELT /
 *     Telegram / a telemetry layer), so unrelated feeds form their own
 *     constellations rather than one blob;
 *   - the board links to every event (parent-child, solid);
 *   - `risk_score`, `summary`, `source` and coordinates ride in `meta` — the
 *     renderer shows them on select; nothing is invented to make a prettier
 *     graph, and an absent field yields a still-legible universe.
 */
import type { BeadData, BeadLink, BeadNode } from '../types';
import { syntheticCreatedAt } from './graph';

/** One record from ShadowBroker's `search_news` / `search_telemetry`. */
export interface ShadowBrokerEventRecord {
  title?: string;
  label?: string;
  summary?: string;
  source?: string;
  source_layer?: string;
  link?: string;
  lat?: number;
  lng?: number;
  time?: string;
  risk_score?: number;
}

export interface ShadowBrokerOptions {
  /** Cluster prefix for the event constellations. Default 'osint'. */
  cluster?: string;
  /** Title of the board planet. Default 'ShadowBroker'. */
  rootTitle?: string;
  /** Cap so a firehose stays legible. Default 200. */
  maxEvents?: number;
}

const BOARD_ID = 'sb:board';

function _time(record: ShadowBrokerEventRecord, index: number, total: number): string {
  if (record.time) {
    const t = Date.parse(record.time);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  // syntheticCreatedAt(value, min, max): spread the undated events across the
  // radial window by their position, never all at one radius.
  return syntheticCreatedAt(index, 0, Math.max(total - 1, 1));
}

/** ShadowBroker records → a BeadSpace universe. Never throws on partial input. */
export function fromShadowBrokerEvents(
  events: readonly ShadowBrokerEventRecord[] | null | undefined,
  options: ShadowBrokerOptions = {},
): BeadData {
  const prefix = options.cluster ?? 'osint';
  const max = Math.max(0, options.maxEvents ?? 200);
  const rows = (events ?? []).slice(0, max);

  const nodes: BeadNode[] = [
    {
      id: BOARD_ID,
      title: options.rootTitle ?? 'ShadowBroker',
      cluster: prefix,
      status: 'open',
      createdAt: rows.length > 0 ? _time(rows[0], 0, rows.length) : syntheticCreatedAt(0, 0, 1),
      meta: { kind: 'board', events: rows.length },
    },
  ];
  const links: BeadLink[] = [];

  rows.forEach((record, index) => {
    const id = `sb:${index}`;
    const layer = record.source_layer ?? record.source ?? 'news';
    nodes.push({
      id,
      title: (record.title ?? record.label ?? 'OSINT event').slice(0, 96),
      cluster: `${prefix} · ${layer}`,
      status: 'open',
      createdAt: _time(record, index, rows.length),
      href: record.link,
      meta: {
        summary: record.summary ?? '',
        source: record.source ?? '',
        layer,
        risk_score: record.risk_score ?? null,
        lat: record.lat ?? null,
        lng: record.lng ?? null,
      },
    });
    links.push({ source: BOARD_ID, target: id, kind: 'parent-child' });
  });

  return { nodes, links };
}
