/**
 * Browser (IIFE) entry: `window.BeadSpace` for pages with no bundler, such as the tunnel
 * dashboard's server-rendered HTML. `npm run build:browser` writes dist/bead-space.iife.js;
 * `npm run build:tunnel` also copies it (and the css) into services/mesh/static/bead-space/.
 */
export { createBeadSpace } from './core/bead-space';
export { fromPipelineUniverse, PIPELINE_CLUSTER_ORDER, PIPELINE_SCHEMA } from './adapters/pipeline';
