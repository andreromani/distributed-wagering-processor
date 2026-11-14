#!/bin/sh
set -eu
test -f /tmp/queues-ready
curl --fail --silent --max-time 2 http://localhost:4566/_localstack/health |
  grep -Eq '"sqs"[[:space:]]*:[[:space:]]*"(available|running)"'
