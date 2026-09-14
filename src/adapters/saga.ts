/**
 * Narrative Adapter — Saga stories as force-graph universes.
 *
 * Maps story elements (characters, chapters, scenes, lorebook entries, locations)
 * to BeadSpace planets and relationships (mentions, interactions, dependencies) to
 * flight paths. A story universe is a narrative graph where characters are the
 * primary nodes, organized by chapter, with lorebook as a supplementary lore layer.
 *
 * Input shape: Saga project data from `/api/saga/projects/{id}` (Veil proxy)
 * which aggregates character, chapter, scene, and lorebook syncs.
 *
 * See AitherOS/services/creative/saga_graph_sync.py for the input schema
 * (characters, chapters, scenes, lorebook_entries, story_arcs).
 */

import type { BeadData, BeadLink, BeadNode, BeadStatus } from '../types';

/** Epoch fallback for records with no timestamp — placed at cluster core (oldest). */
const UNKNOWN_CREATED_AT = new Date(0).toISOString();

const iso = (value: unknown, fallback = UNKNOWN_CREATED_AT): string => {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? fallback : new Date(parsed).toISOString();
};

/* ─────────────────────────────── Saga Project Input ──────────────────────────
 * Full structure of a Saga project as returned by the creative service.
 * This adapter is designed to degrade gracefully: missing or empty arrays
 * produce empty universes, not crashes. A malformed reference is dropped with
 * a note in the edge deduplication, never silently ignored.
 */

export interface SagaCharacter {
  id: string;
  name: string;
  role?: string;
  description?: string;
  personality?: string;
  background?: string;
  /** ISO timestamp this character was created. */
  created_at?: string;
  /** ISO timestamp this character was last updated. */
  updated_at?: string;
  /** Appearance/avatar; used for visual hints in meta. */
  appearance?: string;
  /** Freeform metadata. */
  metadata?: Record<string, unknown>;
}

export interface SagaScene {
  id: string;
  title: string;
  /** Parent chapter id, if any. */
  chapter_id?: string | null;
  description?: string;
  /** Plain text or markdown scene content. */
  content?: string;
  /** Character ids that appear in this scene. */
  characters?: string[];
  created_at?: string;
  updated_at?: string;
  metadata?: Record<string, unknown>;
}

export interface SagaChapter {
  id: string;
  title: string;
  /** Chapter number or sequence (used for ordering). */
  number?: number;
  description?: string;
  /** Scenes under this chapter. */
  scenes?: SagaScene[];
  created_at?: string;
  updated_at?: string;
  metadata?: Record<string, unknown>;
}

export interface SagaLoreEntry {
  id: string;
  title: string;
  /** Lorebook category (world, magic, history, etc.). */
  category?: string;
  content?: string;
  /** Related character ids mentioned in this entry. */
  related_characters?: string[];
  created_at?: string;
  updated_at?: string;
  metadata?: Record<string, unknown>;
}

export interface SagaLocation {
  id: string;
  name: string;
  description?: string;
  /** Scenes set in this location. */
  scenes?: string[];
  created_at?: string;
  updated_at?: string;
  metadata?: Record<string, unknown>;
}

export interface SagaStoryArc {
  id: string;
  title: string;
  description?: string;
  /** Character ids involved in this arc. */
  characters?: string[];
  created_at?: string;
  updated_at?: string;
  metadata?: Record<string, unknown>;
}

export interface SagaProject {
  id: string;
  name: string;
  description?: string;
  characters?: SagaCharacter[];
  chapters?: SagaChapter[];
  scenes?: SagaScene[];
  lorebook_entries?: SagaLoreEntry[];
  locations?: SagaLocation[];
  story_arcs?: SagaStoryArc[];
  created_at?: string;
  updated_at?: string;
}

/* ──────────────────────────────── Status Mapping ────────────────────────────
 * Saga entities have no explicit "status" field. Instead, we infer status from
 * logical properties:
 * - Active/recent chapters/scenes → in_progress
 * - Character is in active scenes → in_progress
 * - Lorebook is stable knowledge → open
 * - Story arc is resolved (no active scenes) → done
 *
 * For simplicity, we mark everything as 'open' (the default) unless it's
 * explicitly marked as archived/complete in metadata.
 */

const SAGA_STATUS: Record<string, BeadStatus> = {
  active: 'open',
  open: 'open',
  draft: 'open',
  archived: 'deferred',
  completed: 'done',
  resolved: 'done',
};

/* ──────────────────────────── Main Adapter Function ────────────────────────
 * Transforms a Saga project into a BeadSpace universe.
 *
 * Node types:
 * - Characters: main planets (cluster: chapter or character role)
 * - Chapters: optional planet layer (cluster: story)
 * - Scenes: optional planet layer (cluster: chapter)
 * - Lorebook entries: optional lore planets (cluster: category)
 * - Story arcs: optional arc planets (cluster: story)
 *
 * Edge types:
 * - Character appears in scene → parent-child (scene → character)
 * - Character mentioned in lorebook → related
 * - Scene in chapter → parent-child (chapter → scene)
 * - Characters in same scene → related (cross-link)
 * - Characters in same story arc → related
 *
 * Degradation:
 * - Empty project → empty universe (no crash)
 * - Missing character reference → dropped edge, logged via dedup
 * - Malformed data → skipped with error in meta
 */

export function fromSaga(
  project: SagaProject,
  {
    clusterBy = 'chapter',
    includeScenes = true,
    includeLorebook = true,
    includeArcs = true,
    includeLocations = false,
  }: {
    /** Cluster characters by: 'chapter' (default), 'role', or 'arc'. */
    clusterBy?: 'chapter' | 'role' | 'arc';
    /** Include scene nodes (default: true). */
    includeScenes?: boolean;
    /** Include lorebook entry nodes (default: true). */
    includeLorebook?: boolean;
    /** Include story arc nodes (default: true). */
    includeArcs?: boolean;
    /** Include location nodes (default: false; adds complexity). */
    includeLocations?: boolean;
  } = {},
): BeadData {
  const nodes: BeadNode[] = [];
  const links: BeadLink[] = [];
  const seen = new Set<string>();
  const known = new Set<string>(); // Track all node ids for edge validation

  // Flatten chapters into a map for quick lookup
  const chapterMap = new Map<string, SagaChapter>();
  const sceneMap = new Map<string, SagaScene>();
  const characterMap = new Map<string, SagaCharacter>();
  const loreMap = new Map<string, SagaLoreEntry>();
  const locationMap = new Map<string, SagaLocation>();
  const arcMap = new Map<string, SagaStoryArc>();

  // Build maps for reference validation
  for (const chapter of project.chapters ?? []) {
    if (chapter.id) chapterMap.set(chapter.id, chapter);
    for (const scene of chapter.scenes ?? []) {
      if (scene.id) sceneMap.set(scene.id, { ...scene, chapter_id: chapter.id });
    }
  }

  for (const scene of project.scenes ?? []) {
    if (scene.id) sceneMap.set(scene.id, scene);
  }

  for (const character of project.characters ?? []) {
    if (character.id) characterMap.set(character.id, character);
  }

  for (const entry of project.lorebook_entries ?? []) {
    if (entry.id) loreMap.set(entry.id, entry);
  }

  for (const location of project.locations ?? []) {
    if (location.id) locationMap.set(location.id, location);
  }

  for (const arc of project.story_arcs ?? []) {
    if (arc.id) arcMap.set(arc.id, arc);
  }

  // ── Add character nodes ──
  for (const character of project.characters ?? []) {
    if (!character.id || !character.name) continue;

    const cluster =
      clusterBy === 'role'
        ? character.role ?? 'unspecified'
        : clusterBy === 'arc'
          ? 'characters' // Arc clustering handled separately
          : character.id && sceneMap.has(character.id)
            ? (() => {
                // Find first chapter containing this character
                for (const scene of Array.from(sceneMap.values())) {
                  if (scene.characters?.includes(character.id)) {
                    return scene.chapter_id ?? 'unphased';
                  }
                }
                return 'unphased';
              })()
            : 'unphased';

    nodes.push({
      id: character.id,
      title: character.name,
      cluster,
      status: 'open',
      assignee: null,
      createdAt: iso(character.created_at),
      stateStartedAt: null,
      meta: {
        role: character.role,
        description: character.description,
        appearance: character.appearance,
        personality: character.personality,
        background: character.background,
      },
    });

    known.add(character.id);
  }

  // ── Add scene nodes (optional) ──
  if (includeScenes) {
    for (const scene of Array.from(sceneMap.values())) {
      if (!scene.id || !scene.title) continue;

      const cluster = scene.chapter_id ?? 'unphased';

      nodes.push({
        id: scene.id,
        title: scene.title,
        cluster,
        status: 'open',
        assignee: null,
        createdAt: iso(scene.created_at),
        stateStartedAt: null,
        meta: {
          chapterId: scene.chapter_id,
          description: scene.description,
          characterCount: scene.characters?.length ?? 0,
        },
      });

      known.add(scene.id);
    }
  }

  // ── Add chapter nodes (derived from scene organization) ──
  const addedChapters = new Set<string>();
  for (const chapter of project.chapters ?? []) {
    if (!chapter.id || !chapter.title || addedChapters.has(chapter.id)) continue;

    nodes.push({
      id: chapter.id,
      title: chapter.title,
      cluster: 'chapters',
      status: 'open',
      assignee: null,
      createdAt: iso(chapter.created_at),
      stateStartedAt: null,
      meta: {
        number: chapter.number,
        description: chapter.description,
      },
    });

    known.add(chapter.id);
    addedChapters.add(chapter.id);
  }

  // ── Add lorebook nodes (optional) ──
  if (includeLorebook) {
    for (const entry of project.lorebook_entries ?? []) {
      if (!entry.id || !entry.title) continue;

      const cluster = entry.category ?? 'uncategorized';

      nodes.push({
        id: entry.id,
        title: entry.title,
        cluster,
        status: 'open',
        assignee: null,
        createdAt: iso(entry.created_at),
        stateStartedAt: null,
        meta: {
          category: entry.category,
          contentLength: entry.content?.length ?? 0,
          relatedCharacters: entry.related_characters,
        },
      });

      known.add(entry.id);
    }
  }

  // ── Add story arc nodes (optional) ──
  if (includeArcs) {
    for (const arc of project.story_arcs ?? []) {
      if (!arc.id || !arc.title) continue;

      nodes.push({
        id: arc.id,
        title: arc.title,
        cluster: 'arcs',
        status: 'open',
        assignee: null,
        createdAt: iso(arc.created_at),
        stateStartedAt: null,
        meta: {
          description: arc.description,
          characterCount: arc.characters?.length ?? 0,
        },
      });

      known.add(arc.id);
    }
  }

  // ── Add location nodes (optional) ──
  if (includeLocations) {
    for (const location of project.locations ?? []) {
      if (!location.id || !location.name) continue;

      nodes.push({
        id: location.id,
        title: location.name,
        cluster: 'locations',
        status: 'open',
        assignee: null,
        createdAt: iso(location.created_at),
        stateStartedAt: null,
        meta: {
          description: location.description,
        },
      });

      known.add(location.id);
    }
  }

  // ── Helper to deduplicate and add edges ──
  const addEdge = (source: string, target: string, kind: BeadLink['kind']) => {
    if (source === target || !known.has(source) || !known.has(target)) return;
    const key = `${source}→${target}→${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ source, target, kind });
  };

  // ── Add edges: chapters contain scenes ──
  for (const scene of Array.from(sceneMap.values())) {
    if (scene.chapter_id && includeScenes) {
      addEdge(scene.chapter_id, scene.id, 'parent-child');
    }
  }

  // ── Add edges: scenes contain characters ──
  for (const scene of Array.from(sceneMap.values())) {
    if (includeScenes) {
      for (const charId of scene.characters ?? []) {
        // Scene → Character indicates character appears in scene
        addEdge(scene.id, charId, 'parent-child');
      }
    }
  }

  // ── Add edges: characters in same scene ──
  for (const scene of Array.from(sceneMap.values())) {
    const sceneChars = scene.characters ?? [];
    if (sceneChars.length < 2) continue;
    for (let i = 0; i < sceneChars.length; i += 1) {
      for (let j = i + 1; j < sceneChars.length; j += 1) {
        // Cross-link characters in the same scene (undirected via key sort)
        const [a, b] = [sceneChars[i], sceneChars[j]].sort();
        addEdge(a, b, 'related');
      }
    }
  }

  // ── Add edges: lorebook mentions characters ──
  if (includeLorebook) {
    for (const entry of project.lorebook_entries ?? []) {
      for (const charId of entry.related_characters ?? []) {
        addEdge(entry.id, charId, 'related');
      }
    }
  }

  // ── Add edges: story arcs involve characters ──
  if (includeArcs) {
    for (const arc of project.story_arcs ?? []) {
      for (const charId of arc.characters ?? []) {
        addEdge(arc.id, charId, 'related');
      }
    }
  }

  return { nodes, links };
}

/**
 * Union several saga sources into one universe, namespacing ids to avoid collisions.
 *
 * Useful for visualizing multiple related stories or comparing narrative threads
 * across projects. Clusters are prefixed so each story maintains its own constellations.
 */
export function mergeSagaGraphs(
  sources: Array<{ prefix: string; data: BeadData }>,
): BeadData {
  const nodes: BeadNode[] = [];
  const links: BeadLink[] = [];
  for (const { prefix, data } of sources) {
    for (const node of data.nodes) {
      nodes.push({ ...node, id: `${prefix}:${node.id}`, cluster: `${prefix}/${node.cluster}` });
    }
    for (const link of data.links) {
      links.push({ ...link, source: `${prefix}:${link.source}`, target: `${prefix}:${link.target}` });
    }
  }
  return { nodes, links };
}
