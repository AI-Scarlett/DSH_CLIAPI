#!/usr/bin/env bash
set -euo pipefail

dsh_home="${DSH_HOME:-${HOME}/.dsh}"
if [[ -n "${DSH_CLIAPI_API_KEY:-}" ]]; then
  api_key="$DSH_CLIAPI_API_KEY"
else
  secrets_path="${dsh_home}/cliproxyapi/plugin-secrets.json"
  [[ -f "$secrets_path" ]] || { echo "找不到 ${secrets_path}，请先运行 install.sh" >&2; exit 2; }
  api_key="$(DSH_CLIAPI_SECRETS="$secrets_path" node -e 'const fs=require("fs"); const value=JSON.parse(fs.readFileSync(process.env.DSH_CLIAPI_SECRETS,"utf8")); if(typeof value.apiKey!=="string"||value.apiKey.length<16)process.exit(2); process.stdout.write(value.apiKey)')"
fi

panel_base="${DSH_CLIAPI_PANEL_BASE:-http://127.0.0.1:3080/dsh-cliapi}"

curl --fail --silent --show-error "${panel_base}/api/status" \
  | jq '{product,version,accounts,defaultModel,auto,modelCount:(.models|length)}'

curl --fail --silent --show-error \
  -H "Authorization: Bearer ${api_key}" \
  -H 'Content-Type: application/json' \
  "${panel_base}/v1/chat/completions" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Reply exactly DSH_CLIAPI_OK"}],"stream":false,"max_tokens":32}' \
  | jq '{model,text:.choices[0].message.content}'
