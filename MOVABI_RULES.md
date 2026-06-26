# Movabi AI Rules

## General

Always analyse before editing.

Generate complete files, not snippets.

Preserve existing architecture.

Explain planned changes before implementation.

## Stack

- Angular
- Ionic
- Express
- Supabase
- PostgreSQL
- Docker
- Stripe Connect

## Database Rules

Never invent columns.

Verify schema before generating SQL.

Profiles table is source of truth.

## Stripe Rules

Users must never be charged unless:

job.status === 'completed'

Use Stripe manual capture.

Connected means:

charges_enabled === true
payouts_enabled === true

Do not rely solely on stripe_connect_status.

## Angular Rules

Use strict typing.

Avoid any.

Preserve routing structure.

## Deployment Rules

Admin:

docker compose build --no-cache movabi-admin
docker compose up -d --no-deps movabi-admin

API:

docker compose build --no-cache movabi-api
docker compose up -d --no-deps movabi-api

## Working Style

Always:

1. Analyse
2. Identify files
3. Explain plan
4. Wait for approval
5. Implement