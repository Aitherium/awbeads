/**
 * A plain wheel over the universe scrolls the page; Ctrl/Cmd+wheel (and a trackpad
 * pinch, which arrives as ctrlKey wheel) zooms. Drag keeps d3's default rule.
 *
 *   npx esbuild test/wheel.ts --bundle --platform=node --format=esm --outfile=test/wheel.mjs --external:jsdom
 *   node test/wheel.mjs
 */
import { zoomGestureAllowed } from '../src/core/bead-space';

const cases: Array<[Parameters<typeof zoomGestureAllowed>[0], boolean]> = [
  [{ type: 'wheel' }, false],
  [{ type: 'wheel', ctrlKey: true }, true],
  [{ type: 'wheel', metaKey: true }, true],
  [{ type: 'mousedown', button: 0 }, true],
  [{ type: 'mousedown', button: 2 }, false],
  [{ type: 'mousedown', button: 0, ctrlKey: true }, false],
  [{ type: 'touchstart' }, true],
];
let failed = 0;
for (const [ev, want] of cases) {
  const got = zoomGestureAllowed(ev);
  if (got !== want) {
    failed += 1;
    console.error(`FAIL ${JSON.stringify(ev)}: got ${got}, want ${want}`);
  }
}
if (failed) process.exit(1);
console.log(`wheel: ${cases.length} cases passed`);
