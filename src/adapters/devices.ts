/**
 * Personal-devices adapter — the "bring your own hardware" universe.
 *
 * A staff member's enrolled endpoints (the self-service My Hardware flow) render
 * as their own little constellation, `mine`. Each device is a planet; the owner
 * gets the orbiting ship, so "your machine is online" reads as a ship circling
 * your planet — the same ownership visual the mesh adapter uses for an agent
 * actively served on a node.
 *
 * Input is the device shape the portal's `GET /api/devices` returns. Every
 * field is optional — an absent field yields a still-legible universe, never a
 * crash. Revoked devices are dropped, not painted as "done" over a machine the
 * user has taken back.
 */
import type { BeadData, BeadNode, BeadStatus } from '../types';
import { syntheticCreatedAt } from './graph';

/** A device the authenticated user enrolled, as the portal returns it. */
export interface DeviceRecord {
  id: string;
  node_id: string;
  name: string;
  os?: string;
  role?: string;
  /** online | offline | enrolling | revoked */
  status?: string;
  agent_scope?: string;
  overlay_ip?: string | null;
  last_seen?: string | null;
  created_at?: string | null;
}

export interface DevicesOptions {
  /** Owner display name — assigned as the bead's `assignee` so their ship orbits it. */
  owner?: string | null;
}

const iso = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0) return new Date(0).toISOString();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? new Date(0).toISOString() : new Date(parsed).toISOString();
};

/** Lifecycle mapping: online = live (ship orbits), offline = paused, enrolling = pending. */
function statusOf(raw: string | undefined): BeadStatus {
  switch ((raw ?? '').toLowerCase()) {
    case 'online': return 'in_progress';
    case 'offline': return 'deferred';
    case 'enrolling': return 'open';
    default: return 'open';
  }
}

export function fromDevices(devices: DeviceRecord[], options: DevicesOptions = {}): BeadData {
  const owner = options.owner || null;
  const nodes: BeadNode[] = (devices ?? [])
    .filter((d) => (d.status ?? '').toLowerCase() !== 'revoked')
    .map((device) => {
      const createdRaw = device.created_at;
      const created = createdRaw ? iso(createdRaw) : syntheticCreatedAt(2, 0, 4);
      return {
        id: device.node_id || device.id,
        title: device.name || device.node_id || 'Unnamed device',
        cluster: 'mine',
        status: statusOf(device.status),
        // The owner's ship orbits every one of their machines — "my hardware,
        // alive right now" at a glance.
        assignee: owner,
        createdAt: created,
        stateStartedAt: device.last_seen ? iso(device.last_seen) : null,
        meta: {
          os: device.os,
          role: device.role,
          node_id: device.node_id,
          agent_scope: device.agent_scope,
          overlay_ip: device.overlay_ip,
          last_seen: device.last_seen,
        },
      };
    });
  return { nodes, links: [] };
}
