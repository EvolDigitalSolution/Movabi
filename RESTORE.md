# Database Restore Instructions

To restore the Movabi database from a backup, follow these steps:

## 1. Identify the backup file
Locate the backup file in the `/backups` directory. It will be a `.sql.gz` file.

## 2. Uncompress the backup
```bash
gunzip /backups/movabi_db_YYYYMMDD_HHMMSS.sql.gz
```

## 3. Stop the services (optional but recommended)
```bash
docker compose stop movabi-api supabase-auth supabase-rest supabase-realtime
```

## 4. Restore the database
```bash
# Drop existing database (WARNING: this will delete all current data)
docker exec -it supabase-db dropdb -U postgres postgres

# Create a fresh database
docker exec -it supabase-db createdb -U postgres postgres

# Restore from backup
cat /backups/movabi_db_YYYYMMDD_HHMMSS.sql | docker exec -i supabase-db psql -U postgres postgres
```

## 5. Restart the services
```bash
docker compose start
```

## 6. Verify the data
Check the app or admin dashboard to ensure the data has been restored correctly.
