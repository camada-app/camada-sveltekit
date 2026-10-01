# @camada/sveltekit

camada for [SvelteKit](https://svelte.dev/docs/kit) as a `handle` hook: enforces the tenant
snapshot inline (your ordered custom rules, then block, allow, challenge), serves a first-party
proof-of-work challenge page and beacon, records the outcomes your actions know (`track()`), and
ships wire events off the response path — through `waitUntil` on Cloudflare, in the background
on Node. Fails open by design — a camada outage or bug never 5xxes your app.

```sh
npm install @camada/sveltekit
```

## Quickstart

```ts
// src/hooks.server.ts
import { camada } from '@camada/sveltekit';

export const handle = camada();   // reads CAMADA_KEY / CAMADA_INGEST_URL / CAMADA_SNAPSHOT_URL from the env
```

With other hooks, put it first so a blocked request never reaches them:

```ts
import { sequence } from '@sveltejs/kit/hooks';
export const handle = sequence(camada(), auth, i18n);
```

Env (printed by camada onboarding / `npm run seed` in dev):

```
CAMADA_KEY=<ingest_token>.<snap_token>
CAMADA_INGEST_URL=http://localhost:8787        # dev only; defaults to production ingest
```

On adapter-node that is `process.env`; on adapter-cloudflare it is the Worker bindings
(`event.platform.env`), read per request. Both are merged, and an app that reads its own config
can pass the values instead:

```ts
export const handle = camada({ key: MY_KEY, ingestUrl: MY_INGEST });
```

Call `camada()` once, at module scope. Engines are cached per resolved configuration inside the
handle, so a Worker isolate serving several tenants never enforces one tenant's snapshot on
another, nor signs its cookies with another's secret. Without `CAMADA_KEY` the handle is inert
(one log line, no requests, no enforcement), so an unprovisioned environment behaves exactly as
if camada were not installed.

## What it does per request

1. Refreshes the snapshot off-path (lazy mode by default — no interval timers, so the handle is
   safe on edge and serverless adapters; `mode: 'timer'` polls on an unref'd interval for a
   long-lived adapter-node process). Every poll and event batch carries
   `x-camada-sdk: @camada/sveltekit/<version>`, and polls ask for snapshot v5 — the container
   that carries your ordered custom rules.
2. Resolves the client from `event.getClientAddress()` — the address your adapter vouches for
   (adapter-node honours its `ADDRESS_HEADER` / `XFF_DEPTH`, adapter-cloudflare reads
   `cf-connecting-ip`) — falling back to `X-Forwarded-For` only under your tenant's
   trusted-proxy config. A client header alone is never the ip. When the adapter has no address
   (prerendering) the ip is null: ip rules and the challenge stand down, the event still ships —
   so a `vite build` with prerendered routes ships one first-visit page event per route from the
   build machine; set `CAMADA_DISABLED=1` in the build env to suppress them. A server-side
   `event.fetch` to the app's own routes (`isSubRequest`) is left alone: one page view is one
   event, and the page-level verdict is not re-applied to your own `load()`.
3. Runs your ordered custom rules, then the allow, block and challenge lists.
4. **Block** → `403` with `x-block-reason` before `resolve()`; the event still ships, with
   `st: 403` and `blk: <reason>` so the analyst counts SDK blocks apart from your own 403s.
5. **Skip** → a skip rule or the allow list wins over a wider block.
6. **Challenge** → a `403` proof-of-work page (HTML navigations) or `403 {"error":"challenge_required"}`
   (everything else); `POST /__camada/challenge` verifies the solution, sets `_cch` and 302s back.
7. Otherwise `resolve(event)` runs, and the settled response ships one batched, redacted event
   with its real status (Authorization and Cookie values never leave the process; credential-looking
   query values are scrubbed — see `@camada/core`).

A first visit gets the shared `_sfp` session cookie through `event.cookies.set()` — SvelteKit
adds the header to whatever `resolve()` returns, so a `redirect()` or a raw `Response` passes
through untouched.

## Options

| option | default | meaning |
|---|---|---|
| `key` | `env.CAMADA_KEY` | `<ingest_token>.<snap_token>`; without it the handle is inert |
| `ingestUrl` | `env.CAMADA_INGEST_URL` | ingest base; batches go to `<ingestUrl>/e` |
| `snapshotUrl` | `<ingestUrl>/snapshot` | snapshot endpoint |
| `trustedProxy` | server config | `none` / `vercel` / `hops:N` / `cidrs:a,b`, or the parsed object |
| `challenge` | `true` | serve the proof-of-work page for `challenge` verdicts |
| `challengePath` | `/__camada/challenge` | where that page posts its solution |
| `snapshotVersion` | `5` | `4` drops the custom rules, `3` the allow/challenge sides too |
| `scriptPath` | `/_cam/b.js` | where the first-party beacon script is served |
| `fpPath` | `/_cam/fp` | where that script posts the beacon; keep it in `scriptPath`'s directory |
| `mode` | `lazy` (or `timer`) | `timer` polls the snapshot on an unref'd interval (long-lived process); `lazy` refreshes it per request off-path. `CAMADA_SERVERLESS=1` forces `lazy` |
| `env` | `process.env` + `platform.env` | overrides the host env (tests, and apps that read config themselves) |

`CAMADA_CHALLENGE=0` in the env switches the challenge off without a code change.

`CAMADA_DISABLED=1` in the env switches everything off, checked per request.

## The first-party beacon

Bots that never run JavaScript are the cheapest to catch. Return the tag from a server `load`
and put it in the page's `<head>`; the handle does the rest:

```ts
// src/routes/+page.server.ts
import { scriptTag } from '@camada/sveltekit';
export const load = (event) => ({ camada: scriptTag(event) });
```

```svelte
<!-- src/routes/+page.svelte -->
<script>
  let { data } = $props();
</script>
<svelte:head>{@html data.camada}</svelte:head>
```

`scriptTag(event)` returns `<script src="/_cam/b.js?r=<rid>" async></script>` — the `rid` is this
request's event id, so the analyst joins the beacon to the page view. The handle serves the
script at `GET /_cam/b.js` (cacheable, 1 h) and relays `POST /_cam/fp` (≤ 32 KB, answers 204)
onto the event batch as a `sig: 1` row stamped with the client ip camada resolved — never the
one the body claims. Both endpoints sit behind the verdict: a blocked client gets 403 there too.
The tag is `''` when camada is off for the request or the project turned the beacon off in its
settings, and the endpoints stand down with it.

## App-context events

The wire shows a `POST /login`; only your action knows whether it failed. Tell camada:

```ts
// src/routes/login/+page.server.ts
import { fail, redirect } from '@sveltejs/kit';
import { track } from '@camada/sveltekit';

export const actions = {
  default: async (event) => {
    const form = await event.request.formData();
    const ok = await signIn(form);
    if (!ok) { track(event, 'login_failed', { user: String(form.get('email')) }); return fail(401); }   // await optional
    redirect(303, '/');
  },
};
```

`track(event, name, { user? })` ships `{ et, uid, rid, sid, ip, ts }` joined to this request's
event. The user identifier is HMAC-hashed in-process with the ingest token — the raw value never
leaves the process. It never throws and is a no-op where the handle did not run. The event name
is free-form; the analyst's rules read this vocabulary:

| event | when |
|---|---|
| `login_failed` / `login_succeeded` | a credential check settled |
| `signup` | an account was created |
| `password_reset` | a reset was requested |
| `mfa_failed` | a second factor was rejected |
| `payment_failed` / `payment_succeeded` | a charge settled |
| `coupon_failed` | a promo code was rejected |

## What this tap can see

This is the in-app position: the beacon, the client hints the browser sends, the real status
your routes answered, the `_sfp` session, and the app context `track()` adds. What SvelteKit
vouches for depends on the adapter. `getClientAddress()` is the one address the handle trusts;
on adapter-cloudflare `event.platform.cf` also supplies `asn`, `country`,
`tlsClientExtensionsSha1` and `httpProtocol`: the handle evaluates ASN, country and
TLS-fingerprint rules on them locally and stamps `asn`, `cc`, `tlsx` and the visitor's own
protocol on the event, but the analyst's capability mask for `sdk-sveltekit` does not credit
them (it is one mask for every adapter), so rules on those conditions are reported as not
enforceable by this SDK and the shipped facts are enrichment only. On adapter-node and the
other adapters none of those exist — the request arrives as a `Request` with no connection
facts, no client protocol, and headers already normalised — so those rules do not fire and the
analyst never scores their absence as evidence. No forwarded header is ever read for any of them.

## Fail open

Every entry point runs inside camada's guard. A dead ingest, a corrupt snapshot, a bug in this
package: telemetry is lost, the request is not.
