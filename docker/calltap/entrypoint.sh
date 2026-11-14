#!/usr/bin/env bash
set -euo pipefail

mkdir -p /data/calls
chown -R calltap:calltap /data

exec setpriv --reuid=1000 --regid=1000 --init-groups "$@"
