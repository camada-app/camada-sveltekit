// @camada/sveltekit — the `handle` hook that binds @camada/core/fetch to a SvelteKit app. The
// pipeline (verdict, block, challenge, beacon, the event) lives in core; this file only says what
// SvelteKit knows: the adapter-resolved client address, the per-request env and execution context
// an edge adapter hands over, the cookie API, and `event.locals` as the per-request slot.
import type { Handle, RequestEvent } from '@sveltejs/kit';
import { guarded, TAP_SVELTEKIT } from '@camada/core';
import { createFetchCamada, SESSION_COOKIE, SESSION_MAX_AGE, withRid, track as coreTrack, scriptTag as coreScriptTag, type FetchCamada, type FetchCamadaOptions, type FetchRequestContext, type FetchVars } from '@camada/core/fetch';
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

/**
 * The `handle` for `src/hooks.server.ts`: `export const handle = camada()`, or first in a
 * `sequence()`. Reads `CAMADA_KEY` (+ `CAMADA_INGEST_URL` / `CAMADA_SNAPSHOT_URL`) from
 * `process.env` or the Cloudflare bindings; inert without a key. One pipeline per call.
 */
export function camada(opts: CamadaSvelteKitOptions = {}): Handle {
  const cam = createFetchCamada({ tap: TAP_SVELTEKIT, sdk: SDK_ID, iife }, opts);   // mode defaults to lazy in core: the handle may run on edge/serverless
  instances.add(cam);
  return async ({ event, resolve }) => {
    // A server-side `event.fetch` to the app's own routes runs the handle again on a fresh event
    // with no user-agent or accept: one page view is one event, and the page-level verdict must
    // not be re-applied to the server's own load().
    if (event.isSubRequest) return resolve(event);
    const r = await cam.before(event.request, contextOf(event));
    if (!r) return resolve(event);
    if (r.response) return r.response;
    const vars = r.vars;
    guarded(() => {
      (event.locals as Record<string, unknown>)[VAR] = vars;
      // The framework cookie API: SvelteKit adds the header to whatever resolve() returns, so a
      // redirect or an immutable Response needs no rebuilding here.
      if (vars.sessionCookie && vars.sid) {
        event.cookies.set(SESSION_COOKIE, vars.sid, {
          path: '/', maxAge: SESSION_MAX_AGE, httpOnly: true, sameSite: 'lax', secure: new URL(event.request.url).protocol === 'https:',
        });
      }
    }, undefined);
    const res = await resolve(event);
    // SvelteKit swaps a 200 carrying an etag for a bodiless 304 after this hook when the client's
    // If-None-Match matches, dropping the body unread: waiting on it would never ship, so an
    // etagged response ships now even when it is an event stream. (That 304 is built by SvelteKit
    // from a fixed header allow-list, so it carries no x-rid; the hook cannot change that.)
    if (res.headers.has('etag')) { cam.after(event.request, vars, res.status); return guarded(() => withRid(res, vars), res); }
    return cam.finish(event.request, vars, res);   // an SSE body ships once it has gone out; anything else ships now, untouched
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
