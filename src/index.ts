// @camada/sveltekit — the one-line install for a SvelteKit app, in src/hooks.server.ts:
//   export const handle = camada();   // env: CAMADA_KEY (+ CAMADA_INGEST_URL / CAMADA_SNAPSHOT_URL in dev)
//   scriptTag(event)                  // the first-party beacon, returned from a load() into the page
//   track(event, 'login_failed', { user })   // an outcome the wire cannot show
export { camada, track, scriptTag, resetCamada, type CamadaSvelteKitOptions, type CamadaSvelteKitVars } from './camada.js';
