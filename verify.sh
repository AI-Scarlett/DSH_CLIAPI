#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DSH_CLIAPI_API_KEY:-}" ]]; then
  echo "请先设置 DSH_CLIAPI_API_KEY（本机 CLIProxyAPI api-keys 中的值）" >&2
  exit 2
fi

panel_base="${DSH_CLIAPI_PANEL_BASE:-http://127.0.0.1:3080/dsh-cliapi}"

curl --fail --silent --show-error "${panel_base}/api/status" \
  | jq '{product,version,accounts,defaultModel,auto,modelCount:(.models|length)}'

curl --fail --silent --show-error \
  -H "Authorization: Bearer ${DSH_CLIAPI_API_KEY}" \
  -H 'Content-Type: application/json' \
  "${panel_base}/v1/chat/completions" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Reply exactly DSH_CLIAPI_OK"}],"stream":false,"max_tokens":32}' \
  | jq '{model,text:.choices[0].message.content}'
