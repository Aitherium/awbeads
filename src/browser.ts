/**
 * Browser (IIFE) entry: `window.BeadSpace` for pages with no bundler, such as the tunnel
 * dashboard's server-rendered HTML. `npm run build:browser` writes dist/bead-space.iife.js;
 * `npm run build:tunnel` also copies it (and the css) into services/mesh/static/bead-space/.
 */
export { createBeadSpace } from './core/bead-space';
export { createStreet, skyAt } from './scene';
export { fromPipelineUniverse, PIPELINE_CLUSTER_ORDER, PIPELINE_SCHEMA } from './adapters/pipeline';
// The aw* family as a universe: a no-bundler page (awdesk's Fleet window) maps the public
// registry (ecosystem.json) with the SAME adapter Veil and the desktop background use,
// instead of re-implementing it inline.
export { fromEcosystem, withEcosystem } from './adapters/ecosystem';
