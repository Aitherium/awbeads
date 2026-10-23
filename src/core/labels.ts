/**
 * Label collision culling — pure, no DOM.
 *
 * A crowded level used to show every label at once (a "label pile-up" — the owner's
 * Constellation and Compute views overlapped into unreadable text). With
 * `labelCollision` on, the engine measures each label's SCREEN box after every camera
 * move and keeps the most important ones that do not touch: the selected body first,
 * then bigger bodies, then the rest. A hidden label still shows on hover (tooltip) and
 * reappears as you zoom in and the boxes separate.
 */

export interface LabelBox {
  id: string;
  /** Left edge, screen px. */
  x: number;
  /** Top edge, screen px. */
  y: number;
  w: number;
  h: number;
  /** Higher wins a collision. */
  priority: number;
}

export interface Viewport {
  width: number;
  height: number;
}

function overlaps(a: LabelBox, b: LabelBox, pad: number): boolean {
  return (
    a.x - pad < b.x + b.w &&
    b.x - pad < a.x + a.w &&
    a.y - pad < b.y + b.h &&
    b.y - pad < a.y + a.h
  );
}

/**
 * The ids whose labels are drawn. Greedy by priority (ties: id order, so the choice is
 * stable across frames and labels do not flicker). Boxes wholly off screen take no room.
 */
export function cullLabels(boxes: LabelBox[], viewport?: Viewport, pad = 6): Set<string> {
  const sorted = [...boxes].sort(
    (a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const kept: LabelBox[] = [];
  const shown = new Set<string>();
  for (const box of sorted) {
    if (!(box.w > 0) || !(box.h > 0)) continue;
    if (
      viewport &&
      (box.x + box.w < 0 || box.y + box.h < 0 || box.x > viewport.width || box.y > viewport.height)
    ) {
      continue;
    }
    if (kept.some((other) => overlaps(box, other, pad))) continue;
    kept.push(box);
    shown.add(box.id);
  }
  return shown;
}

/** Rough text width for a sans label: no DOM measurement, so it is cheap per frame. */
export function estimateLabelWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.6;
}
