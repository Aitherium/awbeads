/**
 * `@aitherium/bead-space/space2d` — the 2D universe, the selection panel and the HUD with
 * NO `three` / `@react-three/fiber` in the import graph. `./space` re-exports Space3D, so
 * a host without those peers (Veil) cannot resolve it at all; this entry is the same
 * components, minus the 3D renderer.
 */
export { Space2D } from './Space2D';
export type { Space2DProps } from './Space2D';
export { SelectionPanel } from './SelectionPanel';
export type {
  ActionResult,
  ExploreResult,
  SelectionPanelProps,
  SpaceActions,
  VerbResult,
} from './SelectionPanel';
export { ModePill, NextPill, ProfileLens, SearchLine } from './Hud';
export type { ModePillProps, NextPillProps, ProfileLensProps, SearchLineProps } from './Hud';
export {
  ADDED_PREFIX, CONFIRM_WINDOW_MS, CORE_LABEL, LENS_TIERS, doingLine, formatMb, hasDoing, isCore,
  isProfileVerb, keptBecause, laneRowsOf, lensOf, lensSentence, profilesOf, stateSentence,
} from './panel-text';
export type { LaneRow, LensSummary, LensTier, ProfileTier } from './panel-text';
// The selection model the host owns, so one alias carries a whole 2D space.
export { initialSelection, reduceSelection } from '../universe/selection';
export type { SelectionAction, SelectionState } from '../universe/selection';
export { visibleAt } from '../universe/levels';
export type { BeadVerb, UniverseData, UniverseNode } from '../types';
export { askGlow } from './scene';
export type { AskGlow } from './scene';
export { FONTS, PALETTE } from './palette';
