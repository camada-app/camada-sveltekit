# Changelog

## Unreleased

Needs the `@camada/core` that exports `readBodyCapped` (the streamed body cap on `/_cam/fp` and
the challenge verify, camada-all-4u4i).

### Fixed

- A client-side navigation to a challenged page (`<path>/__data.json`) gets a SvelteKit data
  redirect through camada's bounce path (`/_cam/reload?to=<page>`). The client loads that URL as
  a document, the bounce 302s it to the page, and the visitor sees the challenge. Before, the
  client rendered the app's 403 error page until a manual reload. A redirect straight to the
  page would be followed client-side and loop. API and `fetch()` calls still get the `403` JSON
  (camada-all-wjln). The bounce answers only while camada is active; a root catch-all route needs
  a param matcher to leave `/_cam/*` alone (README, "The bounce path").

### Changed

- The `exports` map now gives `require` its own `.d.cts` declarations (`import` and `require` each carry a `types` condition), so a CommonJS TypeScript app on `moduleResolution: node16` compiles; CI runs `@arethetypeswrong/cli`. (camada-all-vuzm)

## 0.1.3 (2026-10-09; follows 0.1.2)

Needs `@camada/core` 0.5.1.

### Fixed

- The snapshot client no longer re-polls back to back when `/snapshot` fails. It keeps its blocks and
  waits max(`retry-after`, 5 s), capped at the refresh interval (through `@camada/core` 0.5.1,
  camada-all-pbv9).

## 0.1.2 (2026-10-04; follows 0.1.1)

Needs `@camada/core` 0.5.0.

### Added

- `x-rid` response header: the rid of the request's event row, on every response the app answers
  (an etagged one too), via core's `finish()`. Not on camada's own answers or a 101, nor on
  SvelteKit's own 304 for a matching `If-None-Match` (it keeps only a fixed header allow-list).

### Changed

- `ts` is the request start, so `[ts, ts + dur]` is when the request ran.
- `dur` for a `text/event-stream` response runs to its last byte, or until the client leaves
  (`waitUntil` holds the isolate on Cloudflare). Any other response goes out untouched and ships
  at once, with `dur` = time to first byte. A response with an `etag` ships at once too.

### Fixed

- A first visit to an endpoint that returns a `fetch()` result (or `Response.redirect()`) answered 500
  (`TypeError: immutable`): the `_sfp` cookie is now set on the response through core's
  `withSetCookie`, which copies an immutable one, instead of `event.cookies.set`.
- Path rules match the canonical path (through `@camada/core` 0.5.0). A percent-encoded,
  upper-cased or trailing-slash spelling of a blocked path used to slip past the block.
