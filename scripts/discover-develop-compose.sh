#!/usr/bin/env bash
# Read-only discovery of the develop Compose SERVICE keys and override chain.
# Never infers service keys from container names; never rebuilds from an
# unspecified working tree. Run on the develop host as the deploy user.
set -euo pipefail

echo "== running containers (name | image | status) =="
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' | sort

echo
echo "== compose identity per running container =="
for c in $(docker ps -q); do
  name=$(docker inspect "$c" --format '{{.Name}}' | sed 's#^/##')
  proj=$(docker inspect "$c" --format '{{ index .Config.Labels "com.docker.compose.project" }}' || true)
  files=$(docker inspect "$c" --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' || true)
  dir=$(docker inspect "$c" --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' || true)
  svc=$(docker inspect "$c" --format '{{ index .Config.Labels "com.docker.compose.service" }}' || true)
  printf '%s\n  project=%s\n  service_key=%s\n  config_files=%s\n  working_dir=%s\n' "$name" "$proj" "$svc" "$files" "$dir"
done

echo
echo "== SERVICE keys (compose config --services), using the recorded chain =="
rep=$(docker ps --format '{{.Names}}' | grep -Ei '(api|web|supabase|db)' | head -1 || true)
if [ -n "$rep" ]; then
  files=$(docker inspect "$rep" --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' || true)
  if [ -n "$files" ]; then
    # shellcheck disable=SC2086
    docker compose $files config --services
  else
    echo "no config_files label on '$rep'; inspect manually"
  fi
fi
