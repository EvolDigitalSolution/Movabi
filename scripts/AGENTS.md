# Movabi Rules

Stack:
- Angular
- Ionic
- Express
- Supabase
- PostgreSQL
- Docker
- Stripe Connect

Rules:

- Generate complete files.
- Do not generate snippets.
- Never invent database columns.
- Verify schema before SQL changes.

Stripe:

- Users must not be charged unless job.status === 'completed'
- Use manual capture.
- Connected means:
  charges_enabled === true
  payouts_enabled === true