# ClaudeSpoof macOS：官方签名环境启动器

ClaudeSpoof 2.1 不修改 Claude 的 ASAR、不替换官方主程序、不重签官方 App。它保留 Anthropic 官方签名、Keychain 访问组和硬件密钥 entitlement，只在启动官方进程时传入独立的时区与语言环境。同名外壳负责接管原入口，轻量守护负责识别官方直启、环境不匹配和外壳被更新覆盖。

默认配置：

```json
{
  "enabled": true,
  "timezone": "Europe/London",
  "language": "en-GB"
}
```

## 已验证结果

- 使用 Claude 当前内置的 **Electron 45.3.3** 做离线对照：仅设置 `TZ=Europe/London` 时，主进程与 Renderer 的 `Intl.DateTimeFormat().resolvedOptions().timeZone` 均为 `Europe/London`；再加入 `--lang=en-GB` 后，主进程 locale、Renderer locale、`navigator.language` 均为 `en-GB`。
- 在 Claude **6.28899.6** 官方签名客户端上实测：设备桥接日志恢复为 `connect frame sent: device_id keyed` 和 `authenticated`，不再出现此前的 `device_id none`、`row_pk_enclave` 或 `unavailable_entitlement`。
- `open --env` 全链路已在真实客户端核对：主进程实际环境中的 `TZ=Europe/London`、`LANG/LC_ALL=en_GB.UTF-8`、`LANGUAGE=en-GB`，并带 `--lang=en-GB`。
- 在同一环境实际测试了“会话关联电脑”和“附加文件夹”。
- Claude Code、Computer Use 及客户端启动的子进程继承主进程环境；系统时区保持不变。

## 准备

- macOS 13 或更新版本。
- Node.js 18 或更新版本。
- 未修改、Anthropic 官方签名的 `/Applications/Claude.app`。
- 不需要 `npm ci`，新版本没有 npm 依赖。

如果此前安装过 ClaudeSpoof 1.x：

1. 完全退出 Claude。
2. 运行 `node src/cli.js uninstall-agent` 移除旧看门狗。
3. 使用 1.x 的还原流程恢复官方 App；若官方已经更新，直接保留官方更新后的文件。
4. 再使用本版本的启动器。

## 使用

### 接管原入口（推荐）

完全退出 Claude 后，在 `macos` 目录运行：

```sh
zsh 接管\ Claude\ 原入口.command
# 或
node src/cli.js install-wrapper
```

接管后原路径 `/Applications/Claude.app` 变成一个同名、同图标的轻量外壳，真正的官方 App 原样移到 `/Applications/.ClaudeSpoof/Claude.app`。之后从启动台、Dock、聚焦或浏览器 `claude://` 链接打开 Claude，都经过外壳进入官方 App：进程名、窗口名、Dock 图标仍是 Claude，且由 LaunchServices 正规启动，窗口自动出现。

外壳每次启动都会先验证：

- `codesign --verify --deep --strict` 通过；
- `TeamIdentifier=Q6L2SF6YDW`；
- 存在 `Q6L2SF6YDW.com.anthropic.claude.hwkey` 访问组；
- 当前没有无法确认环境的 Claude 进程在运行。

任何一项不满足都会拒绝启动，不会静默退回真实时区。若由本启动器管理的 Claude 已在运行，再次点击入口只会激活现有窗口，不会重复启动。

从 2.0 升级或更新本仓库后，可只刷新外壳 helper 并启动／重载守护：

```sh
node src/cli.js refresh
```

`refresh` 会先检查当前 Claude 的真实进程环境。当前实例已验证或 Claude 未运行时，不重启 Claude；若当前已有未验证实例，命令会拒绝启动自动修复守护，避免部署动作本身重启客户端。

恢复官方原入口：

```sh
zsh 移除\ Claude\ 原入口接管.command
# 或
node src/cli.js remove-wrapper
```

恢复时会停止守护，官方 App 回到 `/Applications/Claude.app`，从任何入口打开都使用系统真实环境。

### 手动启动（不接管入口）

```sh
node src/cli.js start
```

此方式只启动本次进程并运行环境守护，Dock／Spotlight 等原入口仍指向未伪装的官方 App。

## 更新与官方直启守护

守护约每 5 秒检查一次：

- 外层 `/Applications/Claude.app` 是否仍是 ClaudeSpoof 外壳；
- 当前 Claude 主进程 PID 和可执行文件是否属于预期官方 App；
- 主进程实际 `TZ`、`LANG`、`LC_ALL`、`LANGUAGE` 和 `--lang` 是否与配置一致；
- 启动状态是否与当前进程对应。

行为规则：

- 当前实例全部验证通过时只记录状态，不重启、不激活窗口。
- 手动完全退出 Claude 后保持关闭，守护不会主动拉起。
- 发现官方直启或环境不匹配时，连续两次确认后请求 Claude 正常退出，再经配置环境重开并读取新进程环境复核。
- 如果官方更新用新版 App 覆盖了外层外壳，守护会在 Claude 关闭时重装外壳；旧版会移动到 `.ClaudeSpoof/backups`，不会直接删除。
- 如果外层在运行期间被覆盖，守护会按上述确认流程重开并修复。
- 修复失败会记录错误并退避 5 分钟；重开后环境仍不匹配时，会关闭这次未验证实例，而不是循环重启或静默接受真实时区。

守护由成功启动、`refresh` 或 `start-watcher` 启动，当前用户注销前持续运行。停止守护：

```sh
node src/cli.js stop-watcher
```

## 修改配置

双击 `修改时区语言.command`，或执行：

```sh
node src/cli.js config --timezone Europe/London --language en-GB
node src/cli.js config --timezone Asia/Tokyo --language en-US
node src/cli.js config --timezone America/New_York --language en-US
```

配置位于：

```text
~/Library/Application Support/ClaudeSpoof/config.json
```

完全退出并由启动器重开 Claude 后生效。如果修改配置时旧实例仍在运行，守护会发现环境与新配置不符，并按确认流程请求正常退出后重开。临时停用伪装：

```sh
node src/cli.js config --enabled false
```

恢复启用：

```sh
node src/cli.js config --enabled true
```

## 检查状态

```sh
zsh 检查状态.command
# 或
node src/cli.js status
node src/cli.js verify
```

`status` 同时显示启动状态、守护 PID、`watcher-status.json` 和当前进程环境检查。状态中的 `officialSignature: true` 只证明文件签名和硬件密钥权限仍完整，不代表 Claude 网页接口的长期状态。

## 官方更新

官方更新可以正常安装。外壳每次启动前都会重新检查官方签名，并从安装来源自动刷新 helper；守护处理官方直启和外层被更新覆盖的情况，不依赖 ASAR chunk 哈希或混淆变量名。更新后仍从原入口打开即可。

## 边界与注意事项

- 接管后必须从原入口（外壳）打开 Claude。直接打开隐藏目录 `/Applications/.ClaudeSpoof/Claude.app` 时，运行中的守护会识别并修复；若守护尚未启动或已停止，则不会继承伪装环境。
- 外壳只改变当前客户端进程及其子进程的环境，不修改 macOS 系统时区、地区或语言。
- 由该客户端拉起的 Claude Code、Computer Use 及其他子进程继承同一套 `TZ`／`LANG`；单独在终端运行 `claude` 不继承。
- 浏览器扩展、独立 Chrome 配置、其他桌面应用及网络出口不在本工具的覆盖范围内。
- 外壳与官方 App 使用相同 bundle id `com.anthropic.claudefordesktop`，这是启动台、Dock、聚焦和 `claude://` 链接能原样工作的原因；不要同时保留两份会互相覆盖。
- Cowork 的磁盘空间等独立门槛仍需由客户端满足；设备密钥修复不会绕过这些要求。
- 配置中的旧字段 `overrideAcceptLanguage` 会被忽略；2.x 由 Chromium 的 `--lang` 统一设置页面语言。
- 本工具不读取、上传或修改 Claude 的 Cookie、OAuth token、聊天记录和账号目录。
- 时区和语言只是环境信号的一部分；出口 IP、账号资料、支付信息及其他信号仍可能独立存在。
