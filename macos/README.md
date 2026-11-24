# ClaudeSpoof macOS：官方签名环境启动器

ClaudeSpoof 2.0 不再修改 Claude 的 ASAR、不替换主入口、不重签 App，也不安装自动补丁看门狗。它保留 Anthropic 官方签名、Keychain 访问组和硬件密钥 entitlement，只在启动官方进程时传入独立的时区与语言环境。

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

完全退出 Claude 后，在 `macos` 目录运行：

```sh
zsh 启动\ Claude.command
```

也可以直接执行：

```sh
node src/cli.js start
```

启动器每次都会先验证：

- `codesign --verify --deep --strict` 通过；
- `TeamIdentifier=Q6L2SF6YDW`；
- 存在 `Q6L2SF6YDW.com.anthropic.claude.hwkey` 访问组；
- 当前没有无法确认环境的 Claude 进程在运行。

任何一项不满足都会拒绝启动，不会静默退回真实时区。

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

完全退出并由启动器重开 Claude 后生效。临时停用伪装：

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

状态中的 `officialSignature: true` 只证明文件签名和硬件密钥权限仍完整，不代表 Claude 网页接口的长期状态。

## 官方更新

官方更新可以正常安装。新版不再监听或改写 App 文件，因此没有更新看门狗；每次启动时都会重新检查当前官方签名。更新后仍应通过本启动器打开。

## 边界与注意事项

- 必须通过本启动器打开 Claude。Dock、Spotlight、登录项或浏览器链接直接启动官方 App 时，不会继承这套环境。
- 启动器发现已有 Claude 在运行时不会强行接管；这是为了避免把未伪装的进程误认为已伪装。
- 本工具只改变当前客户端进程及其子进程的环境，不修改 macOS 系统时区、地区或语言。
- 浏览器扩展、独立 Chrome 配置、其他桌面应用及网络出口不在本工具的覆盖范围内。
- Cowork 的磁盘空间等独立门槛仍需由客户端满足；设备密钥修复不会绕过这些要求。
- 配置中的旧字段 `overrideAcceptLanguage` 会被忽略；2.x 由 Chromium 的 `--lang` 统一设置页面语言。
- 本工具不读取、上传或修改 Claude 的 Cookie、OAuth token、聊天记录和账号目录。
- 时区和语言只是环境信号的一部分；出口 IP、账号资料、支付信息及其他信号仍可能独立存在。
