#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd -P)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/dsh-cliapi-smoke.XXXXXX")"
cleanup() {
  case "$test_root" in
    "${TMPDIR:-/tmp}"/dsh-cliapi-smoke.*) rm -rf "$test_root" ;;
  esac
}
trap cleanup EXIT INT TERM

fake_proxy="${test_root}/cli-proxy-api"
printf '#!/bin/sh\nexit 0\n' > "$fake_proxy"
chmod 755 "$fake_proxy"

DSH_HOME="${test_root}/home" \
DSH_CLIAPI_SOURCE_DIR="$repo_root" \
DSH_CLIAPI_SKIP_PLUGIN_ADD=1 \
DSH_CLIAPI_START=0 \
DSH_CLIAPI_OPEN_BROWSER=0 \
CLIPROXYAPI_BINARY="$fake_proxy" \
  "$repo_root/install.sh" --no-start --no-open

for required_file in \
  "${test_root}/home/plugins/dsh-cliapi/package.json" \
  "${test_root}/home/plugins/dsh-cliapi/cordis.patch.yml" \
  "${test_root}/home/cliproxyapi/bin/cli-proxy-api" \
  "${test_root}/home/cliproxyapi/config.yaml" \
  "${test_root}/home/cliproxyapi/plugin-secrets.json" \
  "${test_root}/home/cliproxyapi/dsh-cliapi.json"; do
  [[ -f "$required_file" ]] || { echo "missing ${required_file}" >&2; exit 1; }
done

DSH_SMOKE_HOME="${test_root}/home" node <<'NODE'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.env.DSH_SMOKE_HOME
const secretsPath = join(root, 'cliproxyapi', 'plugin-secrets.json')
const configPath = join(root, 'cliproxyapi', 'config.yaml')
const autoPath = join(root, 'cliproxyapi', 'dsh-cliapi.json')
const secrets = JSON.parse(await readFile(secretsPath, 'utf8'))
const config = await readFile(configPath, 'utf8')
const auto = JSON.parse(await readFile(autoPath, 'utf8'))

if (!/^[a-f0-9]{64}$/.test(secrets.apiKey)) throw new Error('apiKey was not generated safely')
if (!/^[a-f0-9]{64}$/.test(secrets.managementKey)) throw new Error('managementKey was not generated safely')
if (!config.includes(secrets.apiKey) || !config.includes(secrets.managementKey)) throw new Error('config and local secrets disagree')
if (!Array.isArray(auto.candidates) || auto.candidates.length !== 0) throw new Error('fresh Auto config must start empty')
for (const path of [secretsPath, configPath, autoPath]) {
  const mode = (await stat(path)).mode & 0o777
  if (mode !== 0o600) throw new Error(`${path} mode is ${mode.toString(8)}, expected 600`)
}
NODE

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'
  fi
}
secret_hash_before="$(hash_file "${test_root}/home/cliproxyapi/plugin-secrets.json")"
DSH_HOME="${test_root}/home" \
DSH_CLIAPI_SOURCE_DIR="$repo_root" \
DSH_CLIAPI_SKIP_PLUGIN_ADD=1 \
DSH_CLIAPI_START=0 \
DSH_CLIAPI_OPEN_BROWSER=0 \
CLIPROXYAPI_BINARY="$fake_proxy" \
  "$repo_root/install.sh" --no-start --no-open >/dev/null
secret_hash_after="$(hash_file "${test_root}/home/cliproxyapi/plugin-secrets.json")"
[[ "$secret_hash_before" == "$secret_hash_after" ]] || { echo 'upgrade changed existing local secrets' >&2; exit 1; }
find "${test_root}/home/backups" -maxdepth 1 -type d -name 'dsh-cliapi-plugin-*' -print -quit | grep -q . \
  || { echo 'upgrade did not back up the previous plugin' >&2; exit 1; }

legacy_home="${test_root}/legacy-home"
mkdir -p "${legacy_home}/cliproxyapi"
cat > "${legacy_home}/cliproxyapi/config.yaml" <<'YAML'
host: "127.0.0.1"
port: 8317
remote-management:
  allow-remote: false
  secret-key: "$2a$10$anExistingHashCannotBeUsedAsBearerSecret000000000000"
auth-dir: "/tmp/legacy-auths"
api-keys:
  - "legacy-api-key-1234567890"
YAML
chmod 600 "${legacy_home}/cliproxyapi/config.yaml"
DSH_HOME="$legacy_home" \
DSH_CLIAPI_SOURCE_DIR="$repo_root" \
DSH_CLIAPI_SKIP_PLUGIN_ADD=1 \
DSH_CLIAPI_START=0 \
DSH_CLIAPI_OPEN_BROWSER=0 \
CLIPROXYAPI_BINARY="$fake_proxy" \
  "$repo_root/install.sh" --no-start --no-open >/dev/null
DSH_SMOKE_HOME="$legacy_home" node <<'NODE'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
const root = process.env.DSH_SMOKE_HOME
const secrets = JSON.parse(await readFile(join(root, 'cliproxyapi', 'plugin-secrets.json'), 'utf8'))
const config = await readFile(join(root, 'cliproxyapi', 'config.yaml'), 'utf8')
if (secrets.apiKey !== 'legacy-api-key-1234567890') throw new Error('legacy API key was not preserved')
if (!/^[a-f0-9]{64}$/.test(secrets.managementKey)) throw new Error('legacy bcrypt management key was not rotated to a bearer secret')
if (!config.includes(secrets.managementKey) || config.includes('$2a$10$')) throw new Error('legacy config was not migrated')
NODE
find "${legacy_home}/cliproxyapi" -maxdepth 1 -type f -name 'config.yaml.pre-dsh-cliapi-*' -print -quit | grep -q . \
  || { echo 'legacy config migration did not create a backup' >&2; exit 1; }

echo DSH_CLIAPI_INSTALL_SMOKE_OK
