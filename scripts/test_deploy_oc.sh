#!/usr/bin/env bash
# Regression test for deploy_oc.sh's dirty-working-tree guard (final review
# Issue #10). Never touches the deploy host or builds an image: it relies on
# DEPLOY_OC_DRY_RUN=1, which makes deploy_oc.sh print the resolved TAG and
# exit right after the dirty-tree check, before rsync/ssh.
#
# Dirties the tree with one throwaway *untracked* file (created and removed
# by this script only -- no git add/commit/stash/reset/checkout), so it is
# safe to run against a real checkout.
set -euo pipefail
cd "$(dirname "$0")/.."
SCRIPT="scripts/deploy_oc.sh"
FAIL=0

# 1. Clean tree (this script's own execution doesn't dirty it): dry run
#    succeeds and the tag has no "-dirty-" suffix.
if [ -z "$(git status --porcelain)" ]; then
  set +e
  out=$(DEPLOY_OC_DRY_RUN=1 "$SCRIPT" oc test-tag 2>&1)
  rc=$?
  set -e
  if [ "$rc" -eq 0 ] && [ "$out" = "TAG=test-tag" ]; then
    echo "ok - clean tree: dry run exits 0 with unsuffixed tag ($out)"
  else
    echo "FAIL - clean tree: rc=$rc out=$out"
    FAIL=1
  fi
else
  echo "skip - working tree already dirty before the test started"
fi

# 2. Dirty tree, no FORCE_DIRTY: refuses with exit 1, never reaches dry-run
#    echo (so this also proves the check runs before DEPLOY_OC_DRY_RUN).
tmpfile="$(mktemp ./.deploy_oc_dirty_test.XXXXXX)"
cleanup() { rm -f "$tmpfile"; }
trap cleanup EXIT

set +e
out=$(DEPLOY_OC_DRY_RUN=1 "$SCRIPT" oc test-tag 2>&1)
rc=$?
set -e
if [ "$rc" -eq 1 ] && echo "$out" | grep -q "refusing to deploy"; then
  echo "ok - dirty tree without FORCE_DIRTY: refuses (exit 1)"
else
  echo "FAIL - dirty tree without FORCE_DIRTY: rc=$rc out=$out"
  FAIL=1
fi

# 3. Dirty tree with FORCE_DIRTY=1: succeeds, tag gets a -dirty-<epoch> suffix.
set +e
out=$(FORCE_DIRTY=1 DEPLOY_OC_DRY_RUN=1 "$SCRIPT" oc test-tag 2>&1)
rc=$?
set -e
if [ "$rc" -eq 0 ] && echo "$out" | grep -Eq '^TAG=test-tag-dirty-[0-9]+$'; then
  echo "ok - dirty tree with FORCE_DIRTY=1: tags as $out"
else
  echo "FAIL - dirty tree with FORCE_DIRTY=1: rc=$rc out=$out"
  FAIL=1
fi

cleanup
trap - EXIT

if [ "$FAIL" -eq 0 ]; then
  echo "all deploy_oc.sh dirty-tree tests passed"
else
  echo "deploy_oc.sh dirty-tree tests FAILED"
  exit 1
fi
