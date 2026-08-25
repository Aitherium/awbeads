# Attribution

## Code

The rendering engine in `src/core/` is derived from **bead-space** by Wilhelm Bernting,
used under the MIT License.

- Upstream: https://github.com/wbern/bead-space
- Fork this port was taken from: https://github.com/wizzense/bead-space
- Vendored from commit `da9ab2733da572b6158aeebe6d7ae84d6a90ed0a` (2026-07-24)

The upstream project is a single-file Vite app (`src/main.js`, ~1030 lines) bound to a fixed
full-window layout and a hardcoded fictional dataset. This port keeps the visual language and
the flight-path/orbit mathematics essentially verbatim while changing the boundary:

- module-scope singletons → `createBeadSpace(container, data, options)` factory
- `document.querySelector('#map' | '#tip' | ...)` → DOM built inside the caller's container
- `window.innerWidth/innerHeight` measured once → container-measured + `ResizeObserver`
- hardcoded `sample-data.js` import → caller-supplied `{ nodes, links }` + `update()`
- 4 hardcoded cluster anchors → anchors derived from whatever clusters the data contains
- global CSS (`body`, `*`, `h1`, `#map`) → scoped under `.bead-space`
- uncancellable `requestAnimationFrame` loop → cancelled on `destroy()`
- `import * as d3` (full bundle) → granular `d3-*` module imports

Additions beyond the port, all driven by real datasets rather than the fictional sample:

- **cluster tint.** Upstream tints only by owner, which is right for a task universe where every
  interesting planet has one. Most AitherOS data has no owner, so ~360 planets rendered
  identically white and the primary dimension survived only as position. Planets are now tinted
  by owner if there is one and by cluster otherwise, with `clusters()` exposed for a legend.
- **one tint filter per COLOUR, not per node.** Upstream emits an SVG filter per assigned node;
  at ledger scale that is hundreds of filter elements in `<defs>`.
- **labels.** Upstream shows nothing until hover — fine for data you are not trying to read.
- **fit-to-content.** Upstream parks the camera at scale 1 on a canvas sized to its own ~25-node
  sample; real datasets spill off every edge with no sign there is more.
- **status affordances** for `blocked` / `deferred` / `done`, which upstream draws identically
  to `open`.
- **`update()`** — upstream has no live-data path at all; its dataset is fixed at import.

MIT License text: see `LICENSE`.

## Assets

Ship, station and meteor sprites in `assets/kenney-simple-space/` are from
**Kenney's Simple Space** pack and are released under **CC0 1.0 Universal** (public domain).

- Source: https://kenney.nl/assets/simple-space
- Original license text: `assets/kenney-simple-space/LICENSE.txt`

CC0 imposes no attribution requirement; this notice is courtesy.
