#!/usr/bin/env bash
# Self-test for id-token-guard.py. The real workflows must pass. Each case under id-token-guard-tests/ (the
# security review's bypasses review-t1 to review-t4, and deploy.yml misuses), copied over the real workflows,
# must fail.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
workflows="$here/../workflows"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

python3 "$here/id-token-guard.py" "$workflows"
for case_dir in "$here"/id-token-guard-tests/*/; do
  name="$(basename "$case_dir")"
  copy="$work/$name"
  mkdir "$copy"
  cp -R "$workflows/." "$copy/"
  cp -R "$case_dir." "$copy/"
  if python3 "$here/id-token-guard.py" "$copy" > /dev/null; then
    echo "::error::id-token-guard accepted test case $name"
    exit 1
  fi
  echo "rejected as expected: $name"
done
