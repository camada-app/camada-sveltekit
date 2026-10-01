// @camada/sveltekit against the golden v4 snapshot, driven through a RequestEvent-shaped stub and
// a resolve() that answers a fixed Response per path — what SvelteKit hands the handle, minus the
// framework. The fixtures are read through the file: symlink to @camada/core, so this package is
// pinned to the same bytes edge-analyst generates.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Handle, RequestEvent } from '@sveltejs/kit';
import { CHALLENGE_COOKIE } from '@camada/core';
import iife from '@camada/browser/iife-string';
import { camada, resetCamada, track, scriptTag, type CamadaSvelteKitOptions } from '../src/index.js';

const FIX = fileURLToPath(new URL('../node_modules/@camada/core/test/fixtures/blk3/', import.meta.url));
const V4 = { bin: readFileSync(FIX + 'v4-basic.bin'), meta: JSON.stringify(JSON.parse(readFileSync(FIX + 'v4-basic.meta.json', 'utf8'))) };

const BLOCKED_IP = '203.0.113.66';     // block side
const CHALLENGED_IP = '192.0.2.20';    // challenge side only
const CHALLENGED_ASN = 64512;          // challenge side's asn
const HTML = { accept: 'text/html', 'sec-fetch-dest': 'document' };

const CONFIG = { tenant: 'acme', beacon: true, sample: 1, exclude: [], trusted_proxy: { mode: 'none' }, poll_seconds: 30 };
const ENV = { CAMADA_KEY: 'tok-acme.snap-acme', CAMADA_INGEST_URL: 'http://analyst.test', CAMADA_SNAPSHOT_URL: 'http://analyst.test/snapshot' };

function frame(): ArrayBuffer {
  const m = new TextEncoder().encode(V4.meta);
  const f = new Uint8Array(4 + m.length + V4.bin.length);
  new DataView(f.buffer).setUint32(0, m.length, true);
  f.set(m, 4); f.set(new Uint8Array(V4.bin), 4 + m.length);
  return f.buffer;
}

let events: Array<Record<string, unknown>>;
let sdkHeaders: string[];

const fetchImpl: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url);
  if (u.endsWith('/snapshot')) {
    return new Response(frame(), { status: 200, headers: { etag: `"${JSON.parse(V4.meta).version}"`, 'x-camada-config': JSON.stringify(CONFIG) } });
  }
  sdkHeaders.push(new Headers(init?.headers).get('x-camada-sdk') ?? '');
  events.push(...(JSON.parse(String(init?.body)) as Array<Record<string, unknown>>));
  return new Response(null, { status: 202 });
}) as typeof fetch;

/** The adapter-cloudflare shape of `event.platform`; adapter-node leaves it undefined. */
interface Platform { env?: Record<string, string | undefined>; context?: { waitUntil(p: Promise<unknown>): void }; cf?: Record<string, unknown> }
interface CookieSet { name: string; value: string; opts: Record<string, unknown> }
interface Stub { event: RequestEvent; sets: CookieSet[]; waits: Promise<unknown>[] }
interface EventOpts { peer?: string | null; platform?: Pick<Platform, 'env' | 'cf'>; isSubRequest?: boolean }   // a platform means adapter-cloudflare: its execution context is always there

/** A RequestEvent as the handle sees it. `peer: null` makes getClientAddress throw, as SvelteKit does with no address (prerendering). */
function stubEvent(request: Request, o: EventOpts = {}): Stub {
  const sets: CookieSet[] = [];
  const waits: Promise<unknown>[] = [];
  const peer = o.peer === undefined ? '8.8.8.8' : o.peer;
  const platform: Platform | undefined = o.platform ? { ...o.platform, context: { waitUntil: (p) => { waits.push(p); } } } : undefined;
  const event = {
    request,
    url: new URL(request.url),
    locals: {},
    platform,
    isSubRequest: o.isSubRequest ?? false,
    cookies: { set: (name: string, value: string, opts: Record<string, unknown>) => { sets.push({ name, value, opts }); } },
    getClientAddress: () => { if (peer === null) throw new Error('Could not determine clientAddress'); return peer; },
  } as unknown as RequestEvent;
  return { event, sets, waits };
}

const html = (s: string) => new Response(s, { headers: { 'content-type': 'text/html' } });
/** The app behind the handle: what a route would answer, with the two helpers used the way a load/action would. */
/** Three chunks 40 ms apart: a streamed page whose body outlives the handler. */
const slowBody = (): ReadableStream<Uint8Array> => {
  let i = 0;
  return new ReadableStream({
    async pull(ctrl) {
      await new Promise((r) => setTimeout(r, 40));
      if (i++ < 3) ctrl.enqueue(new TextEncoder().encode('x')); else ctrl.close();
    },
  });
};

async function app(event: RequestEvent): Promise<Response> {
  const { pathname } = new URL(event.request.url);
  const method = event.request.method;
  if (pathname === '/') return new Response('home');
  if (pathname === '/cart') return html('<p>cart</p>');
  if (pathname === '/checkout') return html('<p>checkout</p>');
  if (pathname === '/admin/users') return html('<p>admin</p>');
  if (pathname === '/page') return html(`<html><head>${scriptTag(event)}</head><body>page</body></html>`);
  if (pathname === '/redirect') return Response.redirect('http://app.test/', 302);   // immutable headers
  if (pathname === '/etag') return new Response(slowBody(), { headers: { etag: '"v1"' } });
  if (pathname === '/stream') return new Response(slowBody());
  if (pathname === '/login' && method === 'POST') { await track(event, 'login_failed', { user: 'alice@example.com' }); return new Response('no', { status: 401 }); }
  if (pathname === '/signup' && method === 'POST') { void track(event, 'signup'); return new Response('ok'); }   // fire-and-forget: waitUntil must carry it
  return new Response('not found', { status: 404 });
}

const make = (opts: CamadaSvelteKitOptions = {}): Handle => camada({ env: ENV, fetchImpl, ...opts });
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };

/** Drives one request through the handle and settles everything the pipeline started off-path. */
async function call(h: Handle, path: string, init: RequestInit = {}, o: EventOpts = {}): Promise<Response & { stub: Stub }> {
  const stub = stubEvent(new Request(`http://app.test${path}`, init), o);
  const res = await h({ event: stub.event, resolve: app });
  const body = res?.body ? await res.arrayBuffer() : null;   // send the body as the host would: the event ships once it has gone out
  await Promise.all(stub.waits);
  await settle();   // adapter-node has no waitUntil: the lazy snapshot load and the flush settle on their own
  return Object.assign(body === null ? res : new Response(body, res), { stub });   // a bodiless response comes back as the handle returned it
}

/** The first request is cold (fail open) and loads the snapshot. */
async function primed(opts: CamadaSvelteKitOptions = {}): Promise<Handle> {
  const h = make(opts);
  await call(h, '/');
  await call(h, '/');   // second request sees the loaded snapshot
  events.length = 0;
  return h;
}

const nonceOf = (page: string) => /name="nonce" value="([0-9a-f]{32})"/.exec(page)![1];
const solve = (nonce: string): string => {
  for (let n = 0; ; n++) if (createHash('sha256').update(`${nonce}.${n}`).digest('hex').startsWith('0000')) return String(n);
};
const ridOf = (page: string): string => /\?r=([0-9a-f-]{36})"/.exec(page)![1];
const postSolution = (h: Handle, peer: string, body: string) =>
  call(h, '/__camada/challenge', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }, { peer });
const postBeacon = (h: Handle, body: string, peer = '9.9.9.9') =>
  call(h, '/_cam/fp', { method: 'POST', headers: { 'content-type': 'application/json' }, body }, { peer });

beforeAll(() => { delete process.env.CAMADA_KEY; delete process.env.CAMADA_TOKEN; delete process.env.CAMADA_DISABLED; });   // the handle merges process.env; a developer's shell must not steer the suite
beforeEach(() => { events = []; sdkHeaders = []; });
afterEach(() => resetCamada());

describe('capture', () => {
  it('times a streamed page to its last byte, and an etagged one (SvelteKit may 304 it) at once', async () => {
    const h = await primed();
    const res = await h({ event: stubEvent(new Request('http://app.test/stream')).event, resolve: app });
    await settle();
    expect(events.some((e) => e.p === '/stream')).toBe(false);   // the body is still going out
    expect(await res.text()).toBe('xxx');
    await settle();
    expect(events.find((e) => e.p === '/stream')!.dur as number).toBeGreaterThanOrEqual(140);
    await h({ event: stubEvent(new Request('http://app.test/etag')).event, resolve: app });   // body never read, as after a 304
    await settle();
    expect(events.find((e) => e.p === '/etag')).toMatchObject({ st: 200 });
  });

  it('lets an unlisted request through and ships the event with the real status, this tap and the sdk id', async () => {
    const h = await primed();
    expect((await call(h, '/')).status).toBe(200);
    expect(events.at(-1)).toMatchObject({ tap: 'sdk-sveltekit', p: '/', st: 200, ip: '8.8.8.8' });
    await call(h, '/nope');
    expect(events.at(-1)).toMatchObject({ p: '/nope', st: 404 });
    expect(sdkHeaders.length).toBeGreaterThan(0);
    expect(sdkHeaders.every((s) => s === '@camada/sveltekit/0.1.2')).toBe(true);
  });

  it('blocks a listed ip with 403 before resolve() and ships blk', async () => {
    const h = await primed();
    const res = await call(h, '/', {}, { peer: BLOCKED_IP });
    expect(res.status).toBe(403);
    expect(res.headers.get('x-block-reason')).toBe('ip4');
    expect(res.headers.get('x-block-version')).toBeTruthy();
    expect(events.some((e) => e.st === 403 && e.blk === 'ip4' && e.tap === 'sdk-sveltekit')).toBe(true);
    expect(res.stub.sets).toEqual([]);   // camada answered: no session minted for a client it refused
  });
});

describe('challenge', () => {
  it('serves the page, verifies the solution, and lets the cookie holder through', async () => {
    const h = await primed();
    const page = await call(h, '/cart', { headers: HTML }, { peer: CHALLENGED_IP });
    expect(page.status).toBe(403);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('x-camada-challenge')).toBe('1');
    const nonce = nonceOf(await page.text());
    expect(events.some((e) => e.st === 403 && e.blk === 'challenge')).toBe(true);

    const ok = await postSolution(h, CHALLENGED_IP, `nonce=${nonce}&solution=${solve(nonce)}&to=%2Fcart`);
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toBe('/cart');
    expect(ok.headers.get('set-cookie')).toContain(`${CHALLENGE_COOKIE}=`);
    expect(events.some((e) => e.st === 200 && e.ch === 1)).toBe(true);

    const cookie = ok.headers.get('set-cookie')!.split(';')[0];
    expect((await call(h, '/cart', { headers: { cookie, ...HTML } }, { peer: CHALLENGED_IP })).status).toBe(200);
  });
});

describe('first-party beacon', () => {
  it('serves the IIFE at /_cam/b.js and ships nothing for it', async () => {
    const h = await primed();
    const res = await call(h, '/_cam/b.js?r=abc');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(await res.text()).toBe(iife);
    expect(events).toEqual([]);
  });

  it('relays /_cam/fp as a sig:1 row with the server-resolved ip and tap', async () => {
    const h = await primed();
    const res = await postBeacon(h, JSON.stringify({ rid: 'abc', tz: 'UTC', ip: '1.1.1.1', tap: 'proxy' }));
    expect(res.status).toBe(204);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sig: 1, rid: 'abc', tz: 'UTC', ip: '9.9.9.9', tap: 'sdk-sveltekit' });
    expect(events[0].st).toBeUndefined();
  });

  it('scriptTag carries the rid the page event ships, and is empty where the handle did not run', async () => {
    const h = await primed();
    const page = await call(h, '/page');
    const rid = ridOf(await page.text());
    expect(events.find((e) => e.p === '/page')).toMatchObject({ rid, tap: 'sdk-sveltekit' });
    await postBeacon(h, JSON.stringify({ rid, tz: 'UTC' }), '8.8.8.8');
    expect(events.find((e) => e.sig === 1)).toMatchObject({ rid, ip: '8.8.8.8' });

    expect(scriptTag(stubEvent(new Request('http://app.test/page')).event)).toBe('');   // no handle at all
    const off = make({ env: { ...ENV, CAMADA_DISABLED: '1' } });
    expect(await (await call(off, '/page')).text()).toBe('<html><head></head><body>page</body></html>');
  });
});

describe('session', () => {
  it('mints _sfp through event.cookies.set on a first visit, Secure only on https', async () => {
    const h = await primed();
    const res = await call(h, '/');
    expect(res.headers.get('set-cookie')).toBeNull();   // the framework adds the header, not the handle
    expect(res.stub.sets).toHaveLength(1);
    const [set] = res.stub.sets;
    expect(set.name).toBe('_sfp');
    expect(set.value).toMatch(/^[0-9a-f-]{36}$/);
    expect(set.opts).toEqual({ path: '/', maxAge: 2592000, httpOnly: true, sameSite: 'lax', secure: false });
    expect(events.at(-1)).toMatchObject({ sid: set.value, ns: 1 });

    const stub = stubEvent(new Request('https://app.test/'));
    await h({ event: stub.event, resolve: app });
    expect(stub.sets[0].opts.secure).toBe(true);
  });

  it('never overwrites an existing session', async () => {
    const h = await primed();
    const res = await call(h, '/', { headers: { cookie: '_sfp=known-sid' } });
    expect(res.stub.sets).toEqual([]);
    expect(events.at(-1)).toMatchObject({ sid: 'known-sid', ns: 0 });
  });

  it('passes a Response.redirect() from resolve through untouched, the cookie still set via the API', async () => {
    const h = await primed();
    const res = await call(h, '/redirect');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://app.test/');
    expect(() => res.headers.set('x-a', '1')).toThrow();   // still the immutable redirect: nothing was rebuilt
    expect(res.stub.sets.map((s) => s.name)).toEqual(['_sfp']);
    expect(events.at(-1)).toMatchObject({ p: '/redirect', st: 302, ns: 1 });
  });
});

describe('track', () => {
  it('ships an app-context event joined to the request, with the user hashed', async () => {
    const h = await primed();
    const res = await call(h, '/login', { method: 'POST', headers: { cookie: '_sfp=known-sid' } });
    expect(res.status).toBe(401);
    const row = events.find((e) => e.et === 'login_failed')!;
    expect(row).toMatchObject({ tap: 'sdk-sveltekit', sid: 'known-sid', ip: '8.8.8.8' });
    expect(row.uid).toMatch(/^[0-9a-f]{32}$/);
    expect(typeof row.ts).toBe('number');
    expect(row.p).toBeUndefined();
    expect(row.rid).toBe(events.find((e) => e.p === '/login')!.rid);
    expect(JSON.stringify(events)).not.toContain('alice');

    const first = await call(h, '/signup', { method: 'POST' });   // fire-and-forget, on the session just minted
    expect(events.find((e) => e.et === 'signup')).toMatchObject({ uid: null, sid: first.stub.sets[0].value });
  });

  it('is a silent no-op where the handle did not run', async () => {
    await expect(track(stubEvent(new Request('http://app.test/login', { method: 'POST' })).event, 'login_failed', { user: 'x' })).resolves.toBeUndefined();
    const off = make({ env: { ...ENV, CAMADA_DISABLED: '1' } });
    expect((await call(off, '/login', { method: 'POST' })).status).toBe(401);
    const unkeyed = make({ env: {} });
    expect((await call(unkeyed, '/login', { method: 'POST' })).status).toBe(401);
    expect(events).toEqual([]);
  });
});

describe('fail open', () => {
  it('is inert without a key and with CAMADA_DISABLED=1', async () => {
    const unkeyed = make({ env: {} });
    const res = await call(unkeyed, '/', {}, { peer: BLOCKED_IP });
    expect(res.status).toBe(200);
    expect(res.stub.sets).toEqual([]);
    const off = make({ env: { ...ENV, CAMADA_DISABLED: '1' } });
    expect((await call(off, '/', {}, { peer: BLOCKED_IP })).status).toBe(200);
    expect(events).toEqual([]);
  });

  it('lets traffic through while the snapshot server is down', async () => {
    const dead: typeof fetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
    const h = make({ fetchImpl: dead });
    expect((await call(h, '/', {}, { peer: BLOCKED_IP })).status).toBe(200);
    expect((await call(h, '/login', { method: 'POST' })).status).toBe(401);   // track() with ingest down never throws
  });
});

describe('resolving the client address', () => {
  it('takes the peer from getClientAddress and ignores X-Forwarded-For without a trusted proxy', async () => {
    const h = await primed();
    const res = await call(h, '/', { headers: { 'x-forwarded-for': BLOCKED_IP } }, { peer: '8.8.8.8' });
    expect(res.status).toBe(200);
    expect(events.at(-1)).toMatchObject({ ip: '8.8.8.8' });
    expect((await call(h, '/', {}, { peer: BLOCKED_IP })).status).toBe(403);
  });

  it('honours a trusted-proxy X-Forwarded-For behind the peer', async () => {
    const h = await primed({ env: { ...ENV, CAMADA_TRUSTED_PROXY: 'hops:1' } });
    expect((await call(h, '/', { headers: { 'x-forwarded-for': BLOCKED_IP } }, { peer: '10.1.1.1' })).status).toBe(403);
  });

  it('never lets a client header alone become the ip', async () => {
    const h = await primed();
    for (const name of ['x-forwarded-for', 'cf-connecting-ip', 'x-real-ip']) {
      const res = await call(h, '/', { headers: { [name]: BLOCKED_IP } }, { peer: null });
      expect(res.status).toBe(200);
      expect(events.at(-1)).toMatchObject({ p: '/', ip: null });
    }
  });

  it('leaves a sub-request (a server-side event.fetch to its own routes) to resolve(): no verdict, no event, no session', async () => {
    const h = await primed();
    const res = await call(h, '/admin/users', {}, { peer: CHALLENGED_IP, isSubRequest: true });   // a challenge-side path, with no accept/user-agent as SvelteKit forwards it
    expect(res.status).toBe(200);
    expect(events).toEqual([]);
    expect(res.stub.sets).toEqual([]);
    expect(scriptTag(res.stub.event)).toBe('');
  });

  it('still captures a prerender (getClientAddress throws) with ip null and serves no challenge', async () => {
    const h = await primed();
    const res = await call(h, '/admin/users', { headers: HTML }, { peer: null });   // a path on the challenge side
    expect(res.status).toBe(200);
    expect(events.at(-1)).toMatchObject({ p: '/admin/users', st: 200, ip: null });
    expect(res.stub.sets.map((s) => s.name)).toEqual(['_sfp']);
  });
});

describe('cloudflare platform', () => {
  it('reads the key from platform.env and hands the flush to platform.context.waitUntil', async () => {
    const h = make({ env: undefined });   // nothing in code: the Worker bindings carry it
    const cf = { platform: { env: ENV } };
    await call(h, '/', {}, cf);
    await call(h, '/', {}, cf);
    events.length = 0;
    const res = await call(h, '/', {}, cf);
    expect(res.status).toBe(200);
    expect(res.stub.waits.length).toBeGreaterThan(0);
    expect(events.at(-1)).toMatchObject({ p: '/', st: 200 });
    expect((await call(h, '/', {}, { ...cf, peer: BLOCKED_IP })).status).toBe(403);
    const signup = await call(h, '/signup', { method: 'POST' }, cf);
    expect(signup.stub.waits.length).toBeGreaterThan(1);   // track() rides waitUntil too
    expect(events.find((e) => e.et === 'signup')).toBeTruthy();
  });

  it('enforces an asn rule from request.cf and stamps the cf facts on the event', async () => {
    const h = await primed();
    const res = await call(h, '/', { headers: HTML }, { platform: { cf: { asn: CHALLENGED_ASN } } });
    expect(res.status).toBe(403);
    expect(res.headers.get('x-camada-challenge')).toBe('1');
    await call(h, '/', {}, { platform: { cf: { asn: 13335, country: 'US', tlsClientExtensionsSha1: 'abc123', httpProtocol: 'HTTP/2' } } });
    expect(events.at(-1)).toMatchObject({ asn: 13335, cc: 'US', tlsx: 'abc123', proto: 'HTTP/2' });
    await call(h, '/', { headers: { 'x-forwarded-proto': 'http' } });   // adapter-node: no cf, no protocol the host vouches for
    expect(events.at(-1)!.proto).toBeNull();
  });
});
