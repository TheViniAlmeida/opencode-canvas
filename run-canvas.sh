#!/bin/bash
# Wrapper script to run canvas with proper environment
cd "$(dirname "$0")" || exit 1
exec bun run src/canvas/cli.ts "$@"
