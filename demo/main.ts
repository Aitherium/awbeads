/**
 * Demo harness — renders the real AitherOS agent constellation and the real service fleet
 * through the bead-space engine. Run `python demo/build-data.py` first, then:
 *
 *   npx esbuild demo/main.ts --bundle --format=esm --outfile=demo/bundle.js
 *   python -m http.server 8099    # from the package dir
 *   open http://127.0.0.1:8099/demo/
 */
import { createBeadSpace } from '../src/core/bead-space';
import {
  fleetServicesFromConfig,
  fromConstellation,
  fromDebtLedger,
  fromExpeditionTasks,
  fromFleet,
  type ConstellationRecord,
  type DebtRecord,
  type ExpeditionTaskRecord,
  type FleetHealth,
  type FleetServiceRecord,
} from '../src/adapters';
import type { BeadData, BeadSpaceHandle, BeadStats } from '../src/types';

/**
 * A work universe in the shape `GET /expedition/{id}/tasks` returns.
 *
 * Neither of the live datasets produces a PATROL — constellation agents each own only
 * themselves, and fleet services have no owner at all — so without this the multi-stop
 * flight-path routing (the most intricate ported code) is never exercised. Owners here
 * deliberately hold 2–4 active tasks each, plus some unowned active work for stations.
 */
function syntheticExpedition(): ExpeditionTaskRecord[] {
  const phases = ['intake', 'design', 'build', 'verify'];
  const owners = ['demiurge', 'hydra', 'athena', 'apollo', 'scribe'];
  const now = Date.now();
  const tasks: ExpeditionTaskRecord[] = [];

  for (let index = 0; index < 34; index += 1) {
    const phase = phases[index % phases.length];
    tasks.push({
      id: `task-${index}`,
      expedition_id: `exp-${phase}`,
      phase_id: phase,
      title: `${phase} step ${Math.floor(index / phases.length) + 1}`,
      status: 'pending',
      assigned_to: null,
      depends_on: index >= phases.length ? JSON.stringify([`task-${index - phases.length}`]) : '[]',
      created_at: new Date(now - (8 + index * 5) * 86_400_000).toISOString(),
    });
  }

  // Hand each owner a run of tasks so they patrol between several planets.
  let cursor = 0;
  owners.forEach((owner, ownerIndex) => {
    const held = 2 + (ownerIndex % 3);
    for (let n = 0; n < held && cursor < tasks.length; n += 1, cursor += 3) {
      tasks[cursor].status = 'in_progress';
      tasks[cursor].assigned_to = owner;
      tasks[cursor].started_at = new Date(now - (4 + ownerIndex * 26) * 3_600_000).toISOString();
    }
  });
  // Active but unassigned → slow stations.
  for (const index of [2, 11]) {
    tasks[index].status = 'in_progress';
    tasks[index].started_at = new Date(now - 90 * 3_600_000).toISOString();
  }
  tasks[5].status = 'failed';
  tasks[9].status = 'completed';
  tasks[13].status = 'skipped';
  return tasks;
}

const stage = document.querySelector<HTMLElement>('#stage')!;
const summary = document.querySelector<HTMLElement>('#summary')!;
const detail = document.querySelector<HTMLElement>('#detail')!;
const buttons = document.querySelectorAll<HTMLButtonElement>('[data-source]');

let handle: BeadSpaceHandle | null = null;

const legend = document.querySelector<HTMLElement>('#legend')!;

function renderStats(stats: BeadStats): void {
  summary.textContent =
    `${stats.nodes} nodes · ${stats.links} links · ${stats.active} active · ` +
    `${stats.orbits} orbiting · ${stats.patrols} patrolling · ${stats.stations} stations`;
}

/** Without this the colours are decoration. With it they are the answer to "what is this?". */
function renderLegend(): void {
  legend.replaceChildren();
  for (const cluster of handle?.clusters() ?? []) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const dot = document.createElement('i');
    dot.style.background = cluster.color;
    chip.append(dot, document.createTextNode(`${cluster.name} (${cluster.count})`));
    legend.append(chip);
  }
}

async function loadSource(source: string): Promise<BeadData> {
  if (source === 'debt') {
    // Real rows from TECH_DEBT.md via `python AitherOS/dev/tools/debt_graph.py`.
    const response = await fetch('./data/debt.json');
    const payload = (await response.json()) as { records: DebtRecord[] };
    return fromDebtLedger(payload.records, { clusterBy: 'severity' });
  }
  if (source === 'patrol') {
    return fromExpeditionTasks(syntheticExpedition(), { clusterBy: 'phase' });
  }
  if (source === 'constellation') {
    const response = await fetch('./data/constellation.json');
    return fromConstellation((await response.json()) as ConstellationRecord);
  }
  const response = await fetch('./data/fleet.json');
  const payload = (await response.json()) as {
    services: Record<string, Omit<FleetServiceRecord, 'name'>>;
    health: FleetHealth;
  };
  return fromFleet(fleetServicesFromConfig(payload.services), { health: payload.health });
}

async function show(source: string): Promise<void> {
  const data = await loadSource(source);
  for (const button of buttons) {
    button.classList.toggle('active', button.dataset.source === source);
  }
  detail.textContent = 'Click a planet.';

  if (handle) {
    // Same universe, new dataset — this is the path a live poll takes.
    handle.update(data);
    handle.fit();
    renderStats(handle.stats());
    renderLegend();
    return;
  }
  handle = createBeadSpace(stage, data, {
    assetRoot: '../assets/kenney-simple-space',
    // Severity is ordinal — without this the biggest bucket (P2) takes the alarm colour.
    clusterOrder: ['P0', 'P1', 'P2', 'P3'],
    // Debt descriptions are paragraphs; the id plus the area prefix is what actually
    // identifies a row at a glance.
    nodeLabel: (node) => {
      const area = node.meta?.area;
      if (typeof area === 'string' && area.length > 0) {
        return `${node.id} · ${area.split('/')[0].slice(0, 22)}`;
      }
      const text = node.title || node.id;
      return text.length > 32 ? `${text.slice(0, 31).trimEnd()}…` : text;
    },
    onStats: (stats) => {
      renderStats(stats);
      renderLegend();
    },
    onSelect: (node) => {
      detail.textContent = node
        ? `${node.id} · ${node.title} · ${node.status}${node.assignee ? ` · ${node.assignee}` : ''}`
        : 'Click a planet.';
    },
    onFollow: (owner) => {
      if (owner) detail.textContent = `Following ${owner}`;
    },
  });
  // onStats fires from inside createBeadSpace, before `handle` is assigned — so the legend
  // has to be drawn once here or the first render silently has no legend at all.
  renderLegend();
}

for (const button of buttons) {
  button.addEventListener('click', () => {
    void show(button.dataset.source!);
  });
}

// Recreate rather than update when switching source, so clusters re-anchor cleanly.
document.querySelector<HTMLButtonElement>('#rebuild')!.addEventListener('click', () => {
  handle?.destroy();
  handle = null;
  const active = document.querySelector<HTMLButtonElement>('[data-source].active');
  void show(active?.dataset.source ?? 'constellation');
});

// `?source=` lets a headless screenshot pick the universe without clicking.
const requested = new URLSearchParams(location.search).get('source');
void show(requested ?? 'debt');
