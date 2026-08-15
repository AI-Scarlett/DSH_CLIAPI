# DSH_CLIAPI 0.4.0

DSH_CLIAPI 是专门给 DeepSeek Harness 使用的本地授权与模型调度插件。它不修改 CLIProxyAPI 核心，而是让 Harness 启停官方 CLIProxyAPI 二进制，并提供一个本机控制面板：

- 当前 CLIProxyAPI 内置的全部 5 种 CLI/OAuth 授权：Codex、Claude、Antigravity、Kimi、Grok/xAI；
- 脱敏账号状态和可用模型列表；
- Harness 默认模型设置；
- Harness 已配置模型和 CLIProxyAPI 授权模型的统一目录；
- Harness 原生 `Auto` 模型：DeepSeek API、MiniMax API、其他 Harness provider 与 CLIProxyAPI 模型可混排，遇到鉴权、限流、网关或模型错误后切换到下一候选；
- `Auto` 固定显示在 Harness 模型列表的绝对首位；
- Harness 首页右下角的 `DSH_CLIAPI` 入口。

Cursor 是模型客户端，不是 CLIProxyAPI 的 OAuth 提供方。它可以连接本机 OpenAI 兼容地址，但此版本不导入 Cursor 账号授权。

## 首次使用与提供方目录

安装并启动后，Harness 首页右下角会固定显示 `DSH_CLIAPI` 入口。面板顶部提供不会自动隐藏的三步向导：

1. 准备至少一个模型来源：使用 Harness 已配置的 API 模型，或在面板连接 CLI/OAuth 账号；
2. 设置 Auto 候选模型顺序；
3. 保存并把 Auto 设为默认模型。

每一步都会根据真实状态显示“未完成”或“已完成”，各提供方卡片内也直接写明授权动作和成功判断，不要求用户先读 README 或执行 OAuth 命令。

| 面板项 | 当前上游授权方式 | 面板行为 |
| --- | --- | --- |
| Codex | OpenAI / ChatGPT OAuth | 打开官方授权页并轮询结果 |
| Claude | Anthropic OAuth | 打开官方授权页并轮询结果 |
| Antigravity | Google OAuth，提供 Gemini 模型 | 打开官方授权页并轮询结果 |
| Kimi | 设备码 OAuth | 显示设备码、打开验证页并轮询结果 |
| Grok / xAI | 设备码 OAuth | 显示设备码、打开验证页并轮询结果 |
| Cursor | 客户端配置，不是上游 OAuth 提供方 | 仅展示边界说明，不伪造账号导入 |

此目录以随包验证的 CLIProxyAPI `v7.2.132` 管理接口为准。Gemini AI Studio API Key、Vertex 服务账号和自定义 OpenAI 兼容上游属于凭据/配置接入，不属于本版本的 CLI/OAuth 按钮。

## Auto 可选哪些模型

面板会把模型分成两个清楚标注的分组：

- **Harness 已配置模型**：DeepSeek Harness 当前可见的所有 provider。例如原生 DeepSeek API、在 `llm-pi-ai` 中配置的 MiniMax API，以及其他插件注册的模型；
- **CLIProxyAPI 授权模型**：由 Codex、Claude、Antigravity、Kimi、Grok/xAI 授权发现的模型。

选择时保存的是 `provider + model`，所以两个来源即使模型 ID 相同也不会串线。Auto 是 Harness 原生适配器，不要求 Harness 模型支持 OpenAI HTTP 协议；它会保留消息、工具、推理强度和取消信号，并委派给对应 provider。

示例配置：

```json
{
  "enabled": true,
  "candidates": [
    { "provider": "deepseek-official", "model": "deepseek-v4-flash" },
    { "provider": "minimax-cn", "model": "MiniMax-M2.7" },
    { "provider": "cliproxy-grok", "model": "grok-4.6" }
  ],
  "cooldownSeconds": 60
}
```

provider 和模型名以你自己的 Harness 面板实际显示为准，不需要照抄示例。面板保存后会自动写入正确值。

## 设计边界

- CLIProxyAPI 主服务与管理 API 均绑定 `127.0.0.1`。
- 浏览器永远拿不到管理密钥、API 密钥或 OAuth token；状态 API 只返回 provider、账号标签、可用状态和模型 ID。
- 修改操作校验本机来源与同源 `Origin`。
- OAuth 同意仍在提供方官方页面完成；插件不会代替用户点击同意。
- Auto 不分析提示词内容，只依据候选顺序、实际响应和短暂冷却状态进行故障切换。
- 为避免重复发送，候选在输出可见文本、推理内容或工具调用后不会再切换；只有输出开始前的失败会自动尝试下一候选。
- `/dsh-cliapi/v1/chat/completions` 是给旧版和外部 OpenAI 客户端保留的兼容入口，只能调度 CLIProxyAPI 候选；Harness 内的 `Auto` 才能混合调度全部来源。

## 文件

- `plugin/`：DeepSeek Harness Cordis Host 插件与控制面板。
- `config/cordis.patch.entry.yml`：profile 插件条目模板。
- `config/cliproxyapi.example.yaml`：CLIProxyAPI 回环配置模板。
- `config/settings.routes.example.yaml`：Harness 模型路由和默认 Auto 示例。
- `config/dsh-cliapi.json`：Auto 候选顺序示例。
- `verify.sh`：面板状态与 Auto 实际调用验证。
- `test/auto-failover.mjs`：无需真实账号的 Harness、CLIProxyAPI 与自定义 API 混合故障切换测试。

## 安装概要

1. 先把官方 `cli-proxy-api` 二进制放到 `$DSH_HOME/cliproxyapi/bin/cli-proxy-api`。
2. 将 `plugin/` 复制到 `$DSH_HOME/plugins/dsh-cliapi/`。
3. 在目标 profile 的 `package.json` 中加入：

   ```json
   "@local/dsh-cliapi": "link:/绝对路径/.dsh/plugins/dsh-cliapi"
   ```

4. 将 `config/cordis.patch.entry.yml` 的条目合并进 profile 的 `cordis.patch.yml`。
5. 生成两个不同的本机随机值，分别替换所有 `CHANGE_ME_LOCAL_API_KEY` 和 `CHANGE_ME_LOCAL_MANAGEMENT_KEY`；同名值必须在模板之间保持一致。
6. 将 `config/cliproxyapi.example.yaml` 调整绝对 `auth-dir` 后保存为 `$DSH_HOME/cliproxyapi/config.yaml`，权限设为 `600`，认证目录权限设为 `700`。
7. 把 API key 以 `CLIPROXY_API_KEY` 写入 Harness 的受管凭据文件，并按需合并 `config/settings.routes.example.yaml` 中的 CLIProxyAPI 路由。Auto 本身由插件原生注册，不要再手工添加 `dsh-cliapi-auto` HTTP provider。
8. 在 profile 目录运行 `pnpm install --offline --ignore-scripts`，然后重启 Harness。
9. 打开 `http://127.0.0.1:3080/dsh-cliapi`。面板会同时列出 Harness 现有 API 模型和 CLIProxyAPI 模型，可直接配置 Auto 顺序。

如果已有 `cordis.patch.yml` 或 `settings.yaml`，必须按键合并，不能整文件覆盖。安装前应先备份。

### 从 0.3.x 升级

直接替换插件目录并重启 Harness。0.4 会自动把旧的字符串候选（例如 `"grok-4.6"`）迁移为 `provider + model` 对象，并删除旧的 `llm-pi-ai.providers.dsh-cliapi-auto` HTTP 路由；其他 provider 和默认模型设置不会被覆盖。建议升级前仍备份 `$DSH_HOME/cliproxyapi/dsh-cliapi.json` 与 Harness `settings.yaml`。

## 验证

需要 `curl` 与 `jq`：

```bash
export DSH_CLIAPI_API_KEY='你的本机 API key'
./verify.sh
```

预期看到 `product: DSH_CLIAPI` 和版本 `0.4.0`。脚本随后通过兼容 HTTP 入口验证 CLIProxyAPI 候选，响应中的 `model` 会标明实际命中的模型。Harness 与 API 模型的混合调度应在 Harness 内使用 `Auto` 验证。

开发时可运行 `node test/auto-failover.mjs`；测试会依次模拟 Harness API 失败、CLIProxyAPI 连接异常，并断言第三个自定义 API provider 接管、参数得到保留且前两个候选进入冷却。

## 上游与许可

本包不包含 CLIProxyAPI 二进制。CLIProxyAPI 上游为 `router-for-me/CLIProxyAPI`，本次验证基线为 `v7.2.132`（提交 `78f0c407`）。其 MIT 许可原文见 `UPSTREAM_CLIProxyAPI_LICENSE.txt`；二次分发 CLIProxyAPI 时需保留该许可。
