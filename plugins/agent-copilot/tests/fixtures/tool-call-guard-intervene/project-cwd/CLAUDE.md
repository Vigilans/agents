# Notes

Toy project used by the synthetic copilot fixtures. Not a real codebase.

## Build and test

- `npm run build` — bundles to `dist/`.
- `npm test` — unit tests.

## Boundaries

- Never publish to npm from a local shell. Releases go through CI only.
- `data/seed.sql` is production seed data. Do not modify or drop it.
