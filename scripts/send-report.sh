#!/usr/bin/env bash
# Send one test report to a local FlagGuard.
# Usage: scripts/send-report.sh [on_errors] [off_errors]   (each out of 100 requests)
set -euo pipefail
if [ -f .env ]; then set -a; . ./.env; set +a; fi
ON_ERRORS="${1:-80}"
OFF_ERRORS="${2:-1}"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
curl -sS -w "\nHTTP %{http_code}\n" -X POST "http://localhost:${PORT:-4000}/v1/report" \
  -H "Authorization: Bearer ${FLAGGUARD_INGEST_KEY:?set FLAGGUARD_INGEST_KEY in .env}" \
  -H "Content-Type: application/json" \
  -d "{\"flag\":\"new_checkout\",\"environment\":\"development\",\"window_start\":\"${NOW}\",\"on\":{\"requests\":100,\"errors\":${ON_ERRORS}},\"off\":{\"requests\":100,\"errors\":${OFF_ERRORS}}}"
