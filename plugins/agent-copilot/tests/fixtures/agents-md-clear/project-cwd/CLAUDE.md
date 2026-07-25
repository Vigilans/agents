# Notes

Toy project used by the synthetic copilot fixtures. Not a real codebase.

## Migrations

- Schema changes go in `migrations/` as a new numbered file. Never edit an
  applied migration in place — write a follow-up one.
- `data/seed.sql` is production seed data. Do not modify or drop it.
