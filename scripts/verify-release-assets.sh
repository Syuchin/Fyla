#!/usr/bin/env bash
set -euo pipefail

tag="${1:-${GITHUB_REF_NAME:-}}"
expected_version="${RELEASE_VERSION:-${tag#v}}"
repository="${GITHUB_REPOSITORY:-Syuchin/Fyla}"
github_token="${GITHUB_TOKEN:-}"

if [[ -z "${tag}" || -z "${expected_version}" ]]; then
  echo "[verify-release-assets] missing tag or expected version" >&2
  exit 1
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "${tmpdir}"' EXIT

release_json="${tmpdir}/release.json"
tagged_manifest_json="${tmpdir}/tagged-latest.json"
latest_manifest_json="${tmpdir}/latest.json"

api_headers=(
  -H "Accept: application/vnd.github+json"
  -H "User-Agent: fyla-release-verifier"
)

if [[ -n "${github_token}" ]]; then
  api_headers+=(-H "Authorization: Bearer ${github_token}")
fi

retry_curl() {
  local output="$1"
  shift
  local attempt
  for attempt in $(seq 1 12); do
    if curl -fsSL "$@" -o "${output}"; then
      return 0
    fi
    sleep 5
  done
  return 1
}

retry_curl "${release_json}" \
  "${api_headers[@]}" \
  "https://api.github.com/repos/${repository}/releases/tags/${tag}"

retry_curl "${tagged_manifest_json}" \
  "https://github.com/${repository}/releases/download/${tag}/latest.json"

retry_curl "${latest_manifest_json}" \
  "https://github.com/${repository}/releases/latest/download/latest.json"

node - "${release_json}" "${tagged_manifest_json}" "${latest_manifest_json}" "${tag}" "${expected_version}" <<'NODE'
const fs = require('node:fs')

const [releasePath, taggedManifestPath, latestManifestPath, tag, expectedVersion] = process.argv.slice(2)
const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'))
const taggedManifest = JSON.parse(fs.readFileSync(taggedManifestPath, 'utf8'))
const latestManifest = JSON.parse(fs.readFileSync(latestManifestPath, 'utf8'))

function ensure(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

ensure(release.tag_name === tag, `release tag mismatch: ${release.tag_name}`)

const assetNames = new Set((release.assets || []).map(asset => asset.name))
for (const assetName of ['latest.json', 'Fyla_universal.app.tar.gz', 'Fyla_universal.app.tar.gz.sig']) {
  ensure(assetNames.has(assetName), `missing release asset: ${assetName}`)
}

ensure(taggedManifest.version === expectedVersion, `tagged latest.json version mismatch: ${taggedManifest.version}`)
ensure(latestManifest.version === expectedVersion, `latest route version mismatch: ${latestManifest.version}`)

for (const platform of ['darwin-aarch64', 'darwin-x86_64']) {
  const entry = taggedManifest.platforms?.[platform]
  ensure(entry?.url, `missing latest.json platform url for ${platform}`)
  ensure(entry?.signature, `missing latest.json platform signature for ${platform}`)
  ensure(entry.url.includes(`/${tag}/`), `platform ${platform} url does not include tag ${tag}`)
}

console.log(`[verify-release-assets] release ${tag} verified with version ${expectedVersion}`)
NODE
