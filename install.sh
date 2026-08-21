#!/usr/bin/env bash
set -euo pipefail

DSH_CLIAPI_VERSION="${DSH_CLIAPI_VERSION:-0.5.1}"
DSH_CLIAPI_REF="${DSH_CLIAPI_REF:-v${DSH_CLIAPI_VERSION}}"
CLIPROXYAPI_VERSION="${CLIPROXYAPI_VERSION:-7.2.132}"
DSH_HOME_DIR="${DSH_HOME:-${HOME}/.dsh}"
DSH_PROFILE="${DSH_PROFILE:-web}"
PANEL_URL="${DSH_CLIAPI_PANEL_URL:-http://127.0.0.1:3080/dsh-cliapi}"
START_HARNESS="${DSH_CLIAPI_START:-1}"
OPEN_BROWSER="${DSH_CLIAPI_OPEN_BROWSER:-1}"
SOURCE_DIR="${DSH_CLIAPI_SOURCE_DIR:-}"
SKIP_PLUGIN_ADD="${DSH_CLIAPI_SKIP_PLUGIN_ADD:-0}"
SKIP_PROXY_DOWNLOAD="${CLIPROXYAPI_SKIP_DOWNLOAD:-0}"
PROXY_BINARY_SOURCE="${CLIPROXYAPI_BINARY:-}"

usage() {
  cat <<'EOF'
DSH_CLIAPI one-command installer (macOS and Linux)

Usage:
  bash install.sh [--dsh-home PATH] [--profile NAME] [--no-start] [--no-open]

Environment overrides:
  DSH_HOME, DSH_PROFILE, DSH_CLIAPI_PANEL_URL
  DSH_CLIAPI_START=0, DSH_CLIAPI_OPEN_BROWSER=0
  CLIPROXYAPI_VERSION, CLIPROXYAPI_BINARY
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dsh-home)
      [[ $# -ge 2 ]] || { echo "--dsh-home requires a path" >&2; exit 2; }
      DSH_HOME_DIR="$2"
      shift 2
      ;;
    --profile)
      [[ $# -ge 2 ]] || { echo "--profile requires a name" >&2; exit 2; }
      DSH_PROFILE="$2"
      shift 2
      ;;
    --no-start)
      START_HARNESS=0
      shift
      ;;
    --no-open)
      OPEN_BROWSER=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

log() { printf 'DSH_CLIAPI: %s\n' "$*"; }
fail() { printf 'DSH_CLIAPI: ERROR: %s\n' "$*" >&2; exit 1; }

for command_name in curl tar node; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing required command: ${command_name}"
done
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$node_major" =~ ^[0-9]+$ && "$node_major" -ge 20 ]] \
  || fail "Node.js 20 or newer is required (found $(node --version))"

case "$(uname -s)" in
  Darwin) proxy_os=darwin ;;
  Linux) proxy_os=linux ;;
  *) fail "this installer currently supports macOS and Linux; use the manual guide on other systems" ;;
esac
case "$(uname -m)" in
  arm64|aarch64) proxy_arch=aarch64 ;;
  x86_64|amd64) proxy_arch=amd64 ;;
  *) fail "unsupported CPU architecture: $(uname -m)" ;;
esac

mkdir -p "$DSH_HOME_DIR"
DSH_HOME_DIR="$(cd "$DSH_HOME_DIR" && pwd -P)"

temp_root="$(mktemp -d "${TMPDIR:-/tmp}/dsh-cliapi-install.XXXXXX")"
cleanup() {
  case "$temp_root" in
    "${TMPDIR:-/tmp}"/dsh-cliapi-install.*) rm -rf "$temp_root" ;;
  esac
}
trap cleanup EXIT INT TERM

timestamp="$(date +%Y%m%d-%H%M%S)"
plugin_parent="${DSH_HOME_DIR}/plugins"
plugin_dir="${plugin_parent}/dsh-cliapi"
proxy_root="${DSH_HOME_DIR}/cliproxyapi"
proxy_bin_dir="${proxy_root}/bin"
proxy_executable="${proxy_bin_dir}/cli-proxy-api"

mkdir -p "$plugin_parent" "$proxy_bin_dir" "${proxy_root}/auths" "${DSH_HOME_DIR}/backups" "${DSH_HOME_DIR}/logs"
chmod 700 "$DSH_HOME_DIR" "$proxy_root" "${proxy_root}/auths" 2>/dev/null || true

log "preparing plugin v${DSH_CLIAPI_VERSION}"
stage_plugin="${temp_root}/plugin"
mkdir -p "$stage_plugin"
if [[ -n "$SOURCE_DIR" ]]; then
  [[ -f "${SOURCE_DIR}/plugin/package.json" ]] || fail "plugin/package.json was not found under ${SOURCE_DIR}"
  cp -R "${SOURCE_DIR}/plugin/." "$stage_plugin/"
else
  source_archive="${temp_root}/dsh-cliapi.tar.gz"
  source_extract="${temp_root}/source"
  mkdir -p "$source_extract"
  curl -fsSL --retry 3 \
    "https://github.com/AI-Scarlett/DSH_CLIAPI/archive/refs/tags/${DSH_CLIAPI_REF}.tar.gz" \
    -o "$source_archive"
  tar -xzf "$source_archive" -C "$source_extract"
  source_root="$(find "$source_extract" -mindepth 1 -maxdepth 1 -type d -print -quit)"
  [[ -n "$source_root" && -f "${source_root}/plugin/package.json" ]] || fail "downloaded source archive does not contain plugin/package.json"
  cp -R "${source_root}/plugin/." "$stage_plugin/"
fi
for required_file in package.json index.js control.js client.js dashboard.html \
  llm-adapter.js llm-classify.js llm-control.js llm-dashboard.html cordis.patch.yml; do
  [[ -f "${stage_plugin}/${required_file}" ]] || fail "plugin package is missing ${required_file}"
done

if [[ -d "$plugin_dir" ]]; then
  backup_plugin="${DSH_HOME_DIR}/backups/dsh-cliapi-plugin-${timestamp}"
  cp -R "$plugin_dir" "$backup_plugin"
  log "backed up the previous plugin to ${backup_plugin}"
fi
next_plugin="${plugin_parent}/.dsh-cliapi-install-${timestamp}"
cp -R "$stage_plugin" "$next_plugin"
if [[ -d "$plugin_dir" ]]; then
  previous_plugin="${plugin_parent}/.dsh-cliapi-previous-${timestamp}"
  mv "$plugin_dir" "$previous_plugin"
  mv "$next_plugin" "$plugin_dir"
  rm -rf "$previous_plugin"
else
  mv "$next_plugin" "$plugin_dir"
fi

if [[ "$SKIP_PROXY_DOWNLOAD" != "1" || ! -x "$proxy_executable" ]]; then
  if [[ -x "$proxy_executable" ]]; then
    cp "$proxy_executable" "${DSH_HOME_DIR}/backups/cli-proxy-api-${timestamp}"
  fi
  if [[ -n "$PROXY_BINARY_SOURCE" ]]; then
    [[ -f "$PROXY_BINARY_SOURCE" ]] || fail "CLIPROXYAPI_BINARY does not exist: ${PROXY_BINARY_SOURCE}"
    install -m 0755 "$PROXY_BINARY_SOURCE" "$proxy_executable"
  else
    proxy_asset="CLIProxyAPI_${CLIPROXYAPI_VERSION}_${proxy_os}_${proxy_arch}.tar.gz"
    proxy_base="https://github.com/router-for-me/CLIProxyAPI/releases/download/v${CLIPROXYAPI_VERSION}"
    proxy_archive="${temp_root}/${proxy_asset}"
    checksum_file="${temp_root}/checksums.txt"
    log "downloading CLIProxyAPI v${CLIPROXYAPI_VERSION} for ${proxy_os}/${proxy_arch}"
    curl -fsSL --retry 3 "${proxy_base}/${proxy_asset}" -o "$proxy_archive"
    curl -fsSL --retry 3 "${proxy_base}/checksums.txt" -o "$checksum_file"
    expected_checksum="$(awk -v asset="$proxy_asset" '$2 == asset { print $1; exit }' "$checksum_file")"
    [[ -n "$expected_checksum" ]] || fail "CLIProxyAPI checksum entry is missing for ${proxy_asset}"
    if command -v sha256sum >/dev/null 2>&1; then
      actual_checksum="$(sha256sum "$proxy_archive" | awk '{print $1}')"
    else
      actual_checksum="$(shasum -a 256 "$proxy_archive" | awk '{print $1}')"
    fi
    [[ "$actual_checksum" == "$expected_checksum" ]] || fail "CLIProxyAPI checksum verification failed"
    proxy_extract="${temp_root}/proxy"
    mkdir -p "$proxy_extract"
    tar -xzf "$proxy_archive" -C "$proxy_extract"
    [[ -f "${proxy_extract}/cli-proxy-api" ]] || fail "CLIProxyAPI archive did not contain cli-proxy-api"
    install -m 0755 "${proxy_extract}/cli-proxy-api" "$proxy_executable"
    for upstream_file in LICENSE README.md README_CN.md; do
      [[ -f "${proxy_extract}/${upstream_file}" ]] && cp "${proxy_extract}/${upstream_file}" "${proxy_root}/${upstream_file}"
    done
  fi
fi

DSH_INSTALL_HOME="$DSH_HOME_DIR" DSH_INSTALL_TIMESTAMP="$timestamp" node <<'NODE'
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const home = process.env.DSH_INSTALL_HOME
const root = join(home, 'cliproxyapi')
const authDir = join(root, 'auths')
const configPath = join(root, 'config.yaml')
const secretsPath = join(root, 'plugin-secrets.json')
const autoPath = join(root, 'dsh-cliapi.json')
const timestamp = process.env.DSH_INSTALL_TIMESTAMP

await mkdir(authDir, { recursive: true, mode: 0o700 })
await chmod(authDir, 0o700)

async function exists(path) {
  try { await stat(path); return true } catch (error) { if (error?.code === 'ENOENT') return false; throw error }
}

function validSecret(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._~-]{16,256}$/.test(value)
}

function parseExistingConfig(text) {
  const management = text.match(/^\s*secret-key:\s*["']?([^"'\s#]+)["']?\s*$/m)?.[1] ?? ''
  const lines = text.split(/\r?\n/)
  let inApiKeys = false
  let apiKey = ''
  for (const line of lines) {
    if (/^\s*api-keys:\s*$/.test(line)) { inApiKeys = true; continue }
    if (inApiKeys && /^\S/.test(line)) break
    if (inApiKeys) {
      const match = line.match(/^\s*-\s*["']?([^"'\s#]+)["']?\s*$/)
      if (match) { apiKey = match[1]; break }
    }
  }
  return { apiKey, managementKey: management }
}

let secrets
if (await exists(secretsPath)) {
  secrets = JSON.parse(await readFile(secretsPath, 'utf8'))
} else if (await exists(configPath)) {
  const originalConfig = await readFile(configPath, 'utf8')
  const existing = parseExistingConfig(originalConfig)
  secrets = {
    apiKey: validSecret(existing.apiKey) ? existing.apiKey : randomBytes(32).toString('hex'),
    managementKey: validSecret(existing.managementKey) ? existing.managementKey : randomBytes(32).toString('hex'),
  }
  let updatedConfig = originalConfig
  if (!validSecret(existing.apiKey)) {
    const apiPattern = /(^\s*api-keys:\s*\r?\n\s*-\s*).+$/m
    if (!apiPattern.test(updatedConfig)) throw new Error(`existing ${configPath} has no editable api-keys entry`)
    updatedConfig = updatedConfig.replace(apiPattern, `$1"${secrets.apiKey}"`)
  }
  if (!validSecret(existing.managementKey)) {
    const managementPattern = /(^\s*secret-key:\s*).+$/m
    if (!managementPattern.test(updatedConfig)) throw new Error(`existing ${configPath} has no editable remote-management secret-key`)
    updatedConfig = updatedConfig.replace(managementPattern, `$1"${secrets.managementKey}"`)
  }
  if (updatedConfig !== originalConfig) {
    await writeFile(`${configPath}.pre-dsh-cliapi-${timestamp}`, originalConfig, { mode: 0o600, flag: 'wx' })
    const configTemp = `${configPath}.tmp-${process.pid}`
    await writeFile(configTemp, updatedConfig, { mode: 0o600 })
    await rename(configTemp, configPath)
  }
} else {
  secrets = { apiKey: randomBytes(32).toString('hex'), managementKey: randomBytes(32).toString('hex') }
}
if (!validSecret(secrets.apiKey) || !validSecret(secrets.managementKey)) throw new Error('invalid local secret file')

const secretTemp = `${secretsPath}.tmp-${process.pid}`
await writeFile(secretTemp, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 })
await rename(secretTemp, secretsPath)
await chmod(secretsPath, 0o600)

if (!(await exists(configPath))) {
  const config = `host: "127.0.0.1"
port: 8317

tls:
  enable: false
  cert: ""
  key: ""

remote-management:
  allow-remote: false
  secret-key: "${secrets.managementKey}"
  disable-control-panel: true

auth-dir: ${JSON.stringify(authDir)}

api-keys:
  - "${secrets.apiKey}"

debug: false
logging-to-file: true
logs-max-total-size-mb: 100
usage-statistics-enabled: false
request-retry: 3
max-retry-credentials: 0
max-retry-interval: 30
plugins:
  enabled: false
  dir: "plugins"
`
  await writeFile(configPath, config, { mode: 0o600, flag: 'wx' })
}
await chmod(configPath, 0o600)

if (!(await exists(autoPath))) {
  await writeFile(autoPath, `${JSON.stringify({ enabled: true, candidates: [], cooldownSeconds: 60 }, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
}
await chmod(autoPath, 0o600)
NODE

if command -v dsh >/dev/null 2>&1; then
  dsh_command=(dsh)
elif command -v npx >/dev/null 2>&1; then
  dsh_command=(npx --yes @deepseek-ai/dsh)
else
  dsh_command=()
fi

if [[ "$SKIP_PLUGIN_ADD" != "1" ]]; then
  [[ ${#dsh_command[@]} -gt 0 ]] || fail "the official DSH CLI is required to register the plugin"
  log "registering the plugin in the ${DSH_PROFILE} Harness profile through the official DSH CLI"
  env DSH_HOME="$DSH_HOME_DIR" "${dsh_command[@]}" plugin --profile "$DSH_PROFILE" add -w "link:${plugin_dir}"
fi

panel_ready() {
  local status
  status="$(curl -fsS --max-time 2 "${PANEL_URL}/api/status" 2>/dev/null)" || return 1
  [[ "$status" == *'"product":"DSH_CLIAPI"'* && "$status" == *"\"version\":\"${DSH_CLIAPI_VERSION}\""* ]]
}

panel_origin="${PANEL_URL%/dsh-cliapi}"
panel_is_ready=0
if panel_ready; then
  panel_is_ready=1
elif [[ "$START_HARNESS" == "1" && "$SKIP_PLUGIN_ADD" != "1" && ${#dsh_command[@]} -gt 0 ]]; then
  if curl -sS --max-time 2 -o /dev/null "$panel_origin" 2>/dev/null; then
    log "Harness is already running without the new bundle; restart it once, then open the address below"
  else
    log "starting DeepSeek Harness in the background"
    nohup env DSH_HOME="$DSH_HOME_DIR" "${dsh_command[@]}" web >> "${DSH_HOME_DIR}/logs/dsh-cliapi-web.log" 2>&1 &
    printf '%s\n' "$!" > "${DSH_HOME_DIR}/dsh-cliapi-web.pid"
    for _ in {1..40}; do
      if panel_ready; then panel_is_ready=1; break; fi
      sleep 0.5
    done
  fi
fi

printf '\n'
log "installation complete"
log "authorization WebUI: ${PANEL_URL}"
if [[ "$panel_is_ready" == "1" ]]; then
  log "WebUI is ready"
  if [[ "$OPEN_BROWSER" == "1" ]]; then
    if [[ "$proxy_os" == "darwin" ]] && command -v open >/dev/null 2>&1; then
      open "$PANEL_URL" >/dev/null 2>&1 || true
    elif command -v xdg-open >/dev/null 2>&1; then
      xdg-open "$PANEL_URL" >/dev/null 2>&1 || true
    fi
  fi
else
  log "if the page is not available yet, restart Harness with: DSH_HOME=${DSH_HOME_DIR} npx @deepseek-ai/dsh web"
fi
log "local secrets stay in ${proxy_root}; the WebUI never receives them"
