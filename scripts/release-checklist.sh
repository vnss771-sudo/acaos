#!/usr/bin/env bash
set -euo pipefail

TAG="${1:-}"

if [[ -n "$TAG" && ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "Tag must look like v1.2.3 or v1.2.3-rc.1"
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean. Commit or stash changes before cutting a release."
  exit 1
fi

echo "[1/3] Verify repo"
npm run verify

echo "[2/3] Build tracked-files source archive"
npm run pack

echo "[3/3] Release guidance"
if [[ -n "$TAG" ]]; then
  echo "Ready to publish: git tag $TAG && git push origin $TAG"
else
  echo "Pass a semver tag to print the publish command, e.g. npm run release:preflight -- v1.2.3"
fi

echo "Release preflight completed."
