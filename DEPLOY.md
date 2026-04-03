# Deployment Workflow

To deploy the Movabi stack to a production environment, follow these steps:

## 1. Prerequisites
- Docker and Docker Compose installed on the server.
- Domain names configured (A records pointing to the server IP).
- SSL certificates (optional but recommended, use Let's Encrypt).

## 2. Setup
Clone the repository and create the `.env` file from `.env.example`.

```bash
cp .env.example .env
# Edit .env with your production secrets
nano .env
```

## 3. Build and Start
```bash
# Build the containers
docker compose build

# Start the services in detached mode
docker compose up -d
```

## 4. Verify Services
Check the status of the containers:
```bash
docker compose ps
```
Check the logs if any service fails to start:
```bash
docker compose logs -f [service_name]
```

## 5. Automated Backups
Add a cron job to run the `backup.sh` script daily.

```bash
# Edit crontab
crontab -e

# Add this line to run the backup every day at 3 AM
0 3 * * * /bin/bash /path/to/movabi/backup.sh >> /path/to/movabi/backups/backup.log 2>&1
```

## 6. Updating the App
To deploy updates:
```bash
git pull
docker compose build
docker compose up -d
```
Docker Compose will recreate only the containers that have changed.
