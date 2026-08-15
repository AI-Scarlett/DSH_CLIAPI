# DSH_CLIAPI 0.3.0

DSH_CLIAPI 是专门给 DeepSeek Harness 使用的本地授权与模型调度插件。它不修改 CLIProxyAPI 核心，而是让 Harness 启停官方 CLIProxyAPI 二进制，并提供一个本机控制面板：

- 当前 CLIProxyAPI 内置的全部 5 种 CLI/OAuth 授权：Codex、Claude、Antigravity、Kimi、Grok/xAI；
- 脱敏账号状态和可用模型列表；
- Harness 默认模型设置；
- `Auto` 模型：按用户配置的优先级请求，遇到鉴权、限流、网关或模型错误后切换到下一候选；
- `Auto` 固定显示在 Harness 模型列表的绝对首位；
- Harness 首页右下角的 `DSH_CLIAPI` 入口。

Cursor 是模型客户端，不是 CLIProxyAPI 的 OAuth 提供方。它可以连接本机 OpenAI 兼容地址，但此版本不导入 Cursor 账号授权。

## 首次使用与提供方目录

安装并启动后，Harness 首页右下角会固定显示 `DSH_CLIAPI` 入口。面板顶部提供不会自动隐藏的三步向导：

1. 连接至少一个账号；
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

## 设计边界

- CLIProxyAPI 主服务与管理 API 均绑定 `127.0.0.1`。
- 浏览器永远拿不到管理密钥、API 密钥或 OAuth token；状态 API 只返回 provider、账号标签、可用状态和模型 ID。
- 修改操作校验本机来源与同源 `Origin`。
- OAuth 同意仍在提供方官方页面完成；插件不会代替用户点击同意。
- Auto 不分析提示词内容，只依据候选顺序、实际响应和短暂冷却状态进行故障切换。

## 文件

- `plugin/`：DeepSeek Harness Cordis Host 插件与控制面板。
- `config/cordis.patch.entry.yml`：profile 插件条目模板。
- `config/cliproxyapi.example.yaml`：CLIProxyAPI 回环配置模板。
- `config/settings.routes.example.yaml`：Harness 模型路由和默认 Auto 示例。
- `config/dsh-cliapi.json`：Auto 候选顺序示例。
- `verify.sh`：面板状态与 Auto 实际调用验证。
- `test/auto-failover.mjs`：无需真实账号的两候选故障切换测试。

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
7. 把 API key 以 `CLIPROXY_API_KEY` 写入 Harness 的受管凭据文件，并合并 `config/settings.routes.example.yaml`。
8. 在 profile 目录运行 `pnpm install --offline --ignore-scripts`，然后重启 Harness。
9. 打开 `http://127.0.0.1:3080/dsh-cliapi` 完成授权和模型设置。

如果已有 `cordis.patch.yml` 或 `settings.yaml`，必须按键合并，不能整文件覆盖。安装前应先备份。

## 验证

需要 `curl` 与 `jq`：

```bash
export DSH_CLIAPI_API_KEY='你的本机 API key'
./verify.sh
```

预期看到 `product: DSH_CLIAPI`，随后 Auto 请求返回 `DSH_CLIAPI_OK`。响应头 `x-dsh-cliapi-model` 会标明实际命中的模型。

开发时可运行 `node test/auto-failover.mjs`；测试会让第一候选返回模拟 `503`，并断言第二候选成功且 `x-dsh-cliapi-attempts` 为 `2`。

## 上游与许可

本包不包含 CLIProxyAPI 二进制。CLIProxyAPI 上游为 `router-for-me/CLIProxyAPI`，本次验证基线为 `v7.2.132`（提交 `78f0c407`）。其 MIT 许可原文见 `UPSTREAM_CLIProxyAPI_LICENSE.txt`；二次分发 CLIProxyAPI 时需保留该许可。
