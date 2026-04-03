#!/bin/bash

# Configuration
BACKUP_DIR="/backups"
DB_CONTAINER="supabase-db"
DB_NAME="postgres"
DB_USER="postgres"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="${BACKUP_DIR}/movabi_db_${TIMESTAMP}.sql"

# Create backup directory if it doesn't exist
mkdir -p ${BACKUP_DIR}

# Run pg_dump
echo "Starting backup of ${DB_NAME}..."
docker exec ${DB_CONTAINER} pg_dump -U ${DB_USER} ${DB_NAME} > ${BACKUP_FILE}

# Compress the backup
gzip ${BACKUP_FILE}

# Keep only last 7 days of backups
find ${BACKUP_DIR} -name "movabi_db_*.sql.gz" -mtime +7 -delete

echo "Backup completed: ${BACKUP_FILE}.gz"
