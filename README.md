# DSH_CLIAPI

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/AI-Scarlett/DSH_CLIAPI)](https://github.com/AI-Scarlett/DSH_CLIAPI/releases/latest)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek-Harness-5b5bd6)](https://github.com/deepseek-ai/DeepSeek-Harness)
[![CLIProxyAPI](https://img.shields.io/badge/CLIProxyAPI-v7.2.132-16a085)](https://github.com/router-for-me/CLIProxyAPI)

面向 DeepSeek Harness 的本地 CLI/OAuth 授权中心与原生 Auto 模型故障切换插件。

DSH_CLIAPI 负责随 Harness 启停官方 CLIProxyAPI，并在 Harness 内提供一个本机控制面板。用户不需要在终端里逐个执行 OAuth 命令，就能完成账号连接、默认模型设置和 Auto 候选顺序配置。

> 本项目是社区插件，并非 DeepSeek 或 CLIProxyAPI 官方项目。源码包不包含 CLIProxyAPI 二进制。

## 一条命令安装

已经使用 DeepSeek Harness 的 macOS / Linux 用户，直接执行：

```bash
curl -fsSL https://raw.githubusercontent.com/AI-Scarlett/DSH_CLIAPI/v0.4.1/install.sh | bash
```

安装器会下载并校验官方 CLIProxyAPI、生成本机随机密钥、注册 Harness 插件，最后输出并尝试打开：

```text
http://127.0.0.1:3080/dsh-cliapi
```

再次执行同一命令即可升级。OAuth 账号、Auto 顺序和已有 CLIProxyAPI 配置会保留。完整行为、脚本审阅方法和手动安装说明见 [中文文档](README_CN.md)。

## 功能

- 当前 CLIProxyAPI 内置的全部 5 种 CLI/OAuth 授权入口：Codex、Claude、Antigravity、Kimi、Grok/xAI；
- 永久可见的三步首次使用向导，以及每个提供方的授权说明和脱敏连接状态；
- Harness 默认模型设置；
- 自动汇总 Harness 已配置的 DeepSeek、MiniMax、其他 API provider，以及 CLIProxyAPI 授权模型；
- Harness 原生 `Auto` 故障切换：不同来源可混排，遇到鉴权、限流、网关或模型错误时切换下一模型；
- `Auto` 固定在 Harness 模型列表第一项；
- 回环地址、同源写操作校验、管理密钥隔离和令牌不出本机。

## 授权目录

| 面板项 | 授权方式 | 状态 |
| --- | --- | --- |
| Codex | OpenAI / ChatGPT OAuth | 支持 |
| Claude | Anthropic OAuth | 支持 |
| Antigravity | Google OAuth，提供 Gemini 模型 | 支持 |
| Kimi | 设备码 OAuth | 支持 |
| Grok / xAI | 设备码 OAuth | 支持 |
| Cursor | 客户端配置，不是 CLIProxyAPI OAuth 提供方 | 仅说明 |

Gemini AI Studio API Key、Vertex 服务账号和自定义 OpenAI 兼容上游属于凭据或配置接入，不属于本版本的 CLI/OAuth 按钮。

## 安装后配置

如果 Harness 正在运行旧配置，安装器会提示重启一次。

安装并启动 Harness 后：

1. 点击 Harness 首页右下角的 `DSH_CLIAPI`；
2. 使用 Harness 已配置的 API 模型，或连接至少一个 CLI/OAuth 账号；
3. 设置 Auto 候选顺序；
4. 点击“保存并设为默认”。

默认本机面板地址为：`http://127.0.0.1:3080/dsh-cliapi`

Auto 候选按 `provider + model` 保存，面板会分别标注“Harness 已配置模型”和“CLIProxyAPI 授权模型”。0.3.x 的字符串候选和旧 Auto HTTP route 会在重启时自动迁移。兼容入口 `/dsh-cliapi/v1/chat/completions` 只能调度 CLIProxyAPI 候选；混合来源请在 Harness 内选择 `Auto`。

## 验证

```bash
./verify.sh
```

无需真实账号的 Auto 故障切换测试：

```bash
node test/auto-failover.mjs
```

## 安全说明

- CLIProxyAPI 主服务及管理接口只绑定回环地址；
- 浏览器状态接口不返回 OAuth token、API key 或管理密钥；
- 修改接口校验回环来源和同源 `Origin`；
- OAuth 同意动作仍在提供方官方页面完成；
- 提交问题前请删除日志、配置和截图中的邮箱、令牌、密钥及本机路径。

## 上游与许可

本项目在 CLIProxyAPI `v7.2.132`、提交 `78f0c407` 上完成验证。CLIProxyAPI 的 MIT 许可副本见 [UPSTREAM_CLIProxyAPI_LICENSE.txt](UPSTREAM_CLIProxyAPI_LICENSE.txt)。

DSH_CLIAPI 本身使用 [MIT License](LICENSE)。
