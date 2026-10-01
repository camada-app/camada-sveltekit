# Changelog

## 0.1.2 (unreleased; follows 0.1.1)

Needs `@camada/core` 0.5.0.

### Changed

- `ts` is the request start, so `[ts, ts + dur]` is when the request ran.
- `dur` for a `text/event-stream` response runs to its last byte, or until the client leaves
  (`waitUntil` holds the isolate on Cloudflare). Any other response goes out untouched and ships
  at once, with `dur` = time to first byte. A response with an `etag` ships at once too.
