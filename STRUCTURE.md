# Project Structure Overview

The Movabi project is organized into the following directories and files:

- `/movabi` (root)
  - `/docker` (Docker-related configuration)
    - `/nginx` (Nginx reverse proxy configuration)
      - `/conf.d` (Nginx site configurations)
      - `/certs` (SSL certificates)
      - `/vhost.d` (Nginx vhost configurations)
      - `/html` (Nginx static files)
    - `/frontend` (Frontend Dockerfile and Nginx config)
    - `/supabase` (Supabase-related configuration)
      - `kong.yml` (Kong declarative configuration)
  - `/supabase` (Supabase migrations and database setup)
    - `/db`
      - `/migrations` (PostgreSQL migrations)
  - `/frontend` (Angular source code)
    - `/src` (Angular source code)
  - `/server` (Node.js API source code)
    - `Dockerfile` (Node.js Dockerfile)
  - `docker-compose.yml` (Main Docker Compose file)
  - `.env.example` (Example environment variables)
  - `backup.sh` (Database backup script)
  - `RESTORE.md` (Database restore instructions)
  - `DEPLOY.md` (Deployment workflow)
  - `STRUCTURE.md` (Project structure overview)
  - `/backups` (Database backups directory)
