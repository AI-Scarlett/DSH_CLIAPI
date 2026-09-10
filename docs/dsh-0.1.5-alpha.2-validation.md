# DSH 0.1.5-alpha.2 compatibility

Official DSH target: dsh-v0.1.5-alpha.2, Commit b2e3b2a0125854567a4a5fcba75782e42fe84901. The preceding release dsh-v0.1.5-alpha.1 is 5dda764ed3aa172535a7967b06ff95d9cbfe536a.

DSH 0.1.5-alpha.1/.2: CLIAPI uses the public settings.section and agentDefaultModel/runtime services; it does not use removed ctx.agent, Inbox constructors, or the old conversation slot. Source contract checks pass; CLIProxyAPI, credentials, OAuth and real Profile/UI acceptance remain separate gates.

The official release notes were checked against the plugin's actual public seams. No DSH source or @deepseek-ai/* package was modified. Unit/contract checks use disposable fixtures only; no real ~/.dsh Profile, credentials, external Agent Reach channel, OAuth account, or production storefront was changed by this source update.
