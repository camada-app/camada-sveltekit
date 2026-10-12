// @camada/sveltekit — the `handle` hook that binds @camada/core/fetch to a SvelteKit app. The
// pipeline (verdict, block, challenge, beacon, the event) lives in core; this file only says what
// SvelteKit knows: the adapter-resolved client address, the per-request env and execution context
// an edge adapter hands over, the cookie API, and `event.locals` as the per-request slot.
import type { Handle, RequestEvent } from '@sveltejs/kit';
import { guarded, safeReturnTo, TAP_SVELTEKIT } from '@camada/core';
import { createFetchCamada, withRid, withSetCookie, track as coreTrack, scriptTag as coreScriptTag, type FetchCamada, type FetchCamadaOptions, type FetchRequestContext, type FetchVars } from '@camada/core/fetch';
import iife from '@camada/browser/iife-string';
import { SDK_ID } from './version.js';

export type CamadaSvelteKitOptions = FetchCamadaOptions;
export type CamadaSvelteKitVars = FetchVars;

const VAR = '__camada';   // private: track() and scriptTag() are the API, not event.locals
const instances = new Set<FetchCamada>();

type Env = Record<string, string | undefined>;

/** What adapter-cloudflare puts on `event.platform`; every field is optional because other adapters put nothing there. */
interface CfPlatform {
  env?: Env;
  context?: { waitUntil(p: Promise<unknown>): void };
  cf?: { asn?: number; country?: string; tlsClientExtensionsSha1?: string; httpProtocol?: string };
}

const slotOf = (event: RequestEvent): FetchVars | undefined =>
  guarded(() => (event.locals as Record<string, unknown>)[VAR] as FetchVars | undefined, undefined);

/** Everything the runtime vouches for. Nothing here is read from a client header. */
function contextOf(event: RequestEvent): FetchRequestContext {
  const platform = event.platform as CfPlatform | undefined;
  // process.env on adapter-node (and nodejs_compat Workers), the bindings on adapter-cloudflare;
  // a binding can be a KV namespace, so the merge is guarded and core reads only CAMADA_* keys.
  const env = guarded<Env>(() => ({ ...(globalThis as { process?: { env?: Env } }).process?.env, ...platform?.env }), {});
  let peer: string | null = null;
  try { peer = event.getClientAddress(); } catch { /* prerendering, or an adapter with no socket: nothing vouched for */ }
  const exec = platform?.context;
  const cf = platform?.cf;
  return {
    peer, env,
    waitUntil: exec ? (p) => exec.waitUntil(p) : undefined,
    asn: cf?.asn ?? null,
    country: cf?.country ?? null,
    tlsx: cf?.tlsClientExtensionsSha1 ?? null,
    // The connection terminates at Cloudflare, so `cf.httpProtocol` is the visitor's own hop.
    httpVersion: cf?.httpProtocol ? cf.httpProtocol.replace(/^HTTP\//i, '') : null,
  };
}

const DATA_SUFFIX = '/__data.json';
const HTML_DATA_SUFFIX = '.html__data.json';

/** The page a SvelteKit `__data.json` request loads data for, or null when `url` is not one
 *  (kit's own strip_data_suffix, plus its trailing-slash and invalidation params). */
export function dataRequestPage(url: URL): string | null {
  let path: string;
  if (url.pathname.endsWith(HTML_DATA_SUFFIX)) path = url.pathname.slice(0, -HTML_DATA_SUFFIX.length) + '.html';
  else if (url.pathname.endsWith(DATA_SUFFIX)) path = url.pathname.slice(0, -DATA_SUFFIX.length) || '/';
  else return null;
  const q = new URLSearchParams(url.search);
  if (q.get('x-sveltekit-trailing-slash') === '1' && !path.endsWith('/')) path += '/';
  q.delete('x-sveltekit-trailing-slash');
  q.delete('x-sveltekit-invalidated');
  const search = q.toString();
  return path + (search ? '?' + search : '');
}

/**
 * A challenged client-side navigation (camada-all-wjln). SvelteKit's client fetches
 * `<path>/__data.json` and renders the root error page for a 403 there, so the visitor would never
 * meet the challenge. A data `{"type":"redirect"}` to the page itself does not help: the client
 * follows it client-side, fetches `__data.json` again and loops into its 20-redirect error. So the
 * redirect points at camada's bounce path (`<scriptPath dir>/reload?to=<page>`). No app route
 * matches it, so the client falls back to a native navigation (`location.href`), and the bounce
 * then 302s that document request to the page, which gets the HTML challenge. Every other answer,
 * and any request that is not a `__data.json` fetch (an API call from app code), is left as it is.
 */
function forNavigation(req: Request, res: Response, bouncePath: string): Response {
  return guarded(() => {
    if (res.status !== 403 || res.headers.get('x-camada-challenge') !== '1') return res;
    const page = dataRequestPage(new URL(req.url));
    if (page === null) return res;
    void res.body?.cancel().catch(() => {});
    return new Response(JSON.stringify({ type: 'redirect', location: `${bouncePath}?to=${encodeURIComponent(page)}` }), {
      status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-camada-challenge': '1' },
    });
  }, res);
}

/**
 * The `handle` for `src/hooks.server.ts`: `export const handle = camada()`, or first in a
 * `sequence()`. Reads `CAMADA_KEY` (+ `CAMADA_INGEST_URL` / `CAMADA_SNAPSHOT_URL`) from
 * `process.env` or the Cloudflare bindings; inert without a key. One pipeline per call.
 */
export function camada(opts: CamadaSvelteKitOptions = {}): Handle {
  const cam = createFetchCamada({ tap: TAP_SVELTEKIT, sdk: SDK_ID, iife }, opts);   // mode defaults to lazy in core: the handle may run on edge/serverless
  instances.add(cam);
  const bouncePath = (opts.scriptPath ?? '/_cam/b.js').replace(/[^/]*$/, 'reload');   // beside the beacon: camada's own directory
  return async ({ event, resolve }) => {
    // A server-side `event.fetch` to the app's own routes runs the handle again on a fresh event
    // with no user-agent or accept: one page view is one event, and the page-level verdict must
    // not be re-applied to the server's own load().
    if (event.isSubRequest) return resolve(event);
    // The bounce a challenged data request sends the client through (see forNavigation): a
    // same-site 302 back to the page, which then meets the verdict as a document request.
    const bounce = guarded(() => {
      const url = new URL(event.request.url);
      if (event.request.method !== 'GET' || url.pathname !== bouncePath) return null;
      return new Response(null, { status: 302, headers: { location: safeReturnTo(url.searchParams.get('to')), 'cache-control': 'no-store' } });
    }, null);
    if (bounce) return bounce;
    const r = await cam.before(event.request, contextOf(event));
    if (!r) return resolve(event);
    if (r.response) return forNavigation(event.request, r.response, bouncePath);
    const vars = r.vars;
    guarded(() => { (event.locals as Record<string, unknown>)[VAR] = vars; }, undefined);
    // The _sfp cookie rides the response, not `event.cookies.set`: SvelteKit appends those in place
    // after resolve(), which throws on an immutable Response (a `fetch()` result, `Response.redirect()`).
    // withSetCookie copies such a response; the hook sees it, so the 500 never happens.
    const res = await resolve(event);
    // SvelteKit swaps a 200 carrying an etag for a bodiless 304 after this hook when the client's
    // If-None-Match matches, dropping the body unread: waiting on it would never ship, so an
    // etagged response ships now even when it is an event stream. (That 304 is built by SvelteKit
    // from a fixed header allow-list, so it carries no x-rid; the hook cannot change that.)
    const out = guarded(() => (vars.sessionCookie ? withSetCookie(res, vars.sessionCookie) : res), res);
    if (out.headers.has('etag')) { cam.after(event.request, vars, out.status); return guarded(() => withRid(out, vars), out); }
    return cam.finish(event.request, vars, out);   // an SSE body ships once it has gone out; anything else ships now, untouched
  };
}

/**
 * Records an outcome the app knows and the wire cannot show (`login_failed`, `signup`,
 * `payment_failed`, ...), joined to this request's event by rid and session. The user identifier
 * is HMAC-hashed in-process. Never throws; a no-op where the handle did not run for this event.
 */
export const track = (event: RequestEvent, et: string, data?: { user?: string }): Promise<void> => coreTrack(slotOf(event), et, data);

/** The beacon `<script>` tag for this request's page; `''` where the handle did not run or the tenant turned the beacon off. */
export const scriptTag = (event: RequestEvent): string => coreScriptTag(slotOf(event));

/** Test/reset hook: stops and drops every engine of every handle this module created. */
export function resetCamada(): void {
  for (const cam of instances) cam.reset();
}
