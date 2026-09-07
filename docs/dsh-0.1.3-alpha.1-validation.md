# CLIAPI 0.5.3 validation

Official target: `deepseek-ai/deepseek-harness` tag `dsh-v0.1.3-alpha.1`, Commit `d347e703908d0406b7a7ef80e3a0e594d86b2215`. The official GitHub release is ahead of npm (`0.1.2-rc.1`). The current three-version window is `0.1.2-alpha.5`, `0.1.2-rc.1`, `0.1.3-alpha.1`.

Validation used the built official source CLI, Node 26.8.1 on macOS arm64, a disposable DSH_HOME and synthetic project. The plugin was added with fixed argument arrays, included in `--dump-config`, loaded in a cold Web host, and removed with the official CLI. The final composed configuration contains none of the seven test plugin entries. Synthetic session files were retained. No real Profile was installed or restarted.

These checks establish source compatibility, isolated configuration composition and host startup. Browser interaction, Windows/Linux host runtime, real account/model calls, real Profile acceptance, source publication, Registry merge and public storefront readback are separate and unverified here. Removal is not a tested version rollback; rollback remains unknown. Historical compatibility keys describe earlier evidence, not a rerun of every old release with this candidate.
Automated validation: 41 tests; `npm test (plugin directory)`. Package entrypoints were checked with `npm pack --dry-run --ignore-scripts`.
