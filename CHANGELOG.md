# Changelog

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
