<p align="center">
  <img src="art/logo.png" width="160" alt="ClaudeSpoof logo" />
</p>

# ClaudeSpoof

面向 Claude **Android、macOS、Windows** 三个客户端的时区／语言环境自定义工具。三种实现彼此独立，可按平台单独使用。

默认桌面配置为 `Europe/London`／`en-GB`，也可改成其他合法 IANA 时区与 BCP-47 语言标签。

## 客户端与实现

| 平台 | 当前版本 | 实现方式 | 官方客户端文件 | 详细说明 |
| --- | --- | --- | --- | --- |
| Android | 1.5.1 | LSPosed hook Android 系统时区、locale 与运营商 API | 不修改 | [android/README.md](android/README.md) |
| macOS | 2.0.0 | 同名外壳接管原入口，LaunchServices `open --env` 传 `TZ` 与 Chromium `--lang` | 不修改 | [macos/README.md](macos/README.md) |
| Windows | 1.0.2 | 官方进程内存启用临时调试入口，运行时注入并校验 | 不修改 | [windows/README.md](windows/README.md) |

## 快速开始

### Android

1. 安装 APK，在 LSPosed 中启用模块，作用域只选择 Claude。
2. 强行停止并重新打开 Claude。
3. 在 ClaudeSpoof 设置界面配置时区、语言和运营商。

Android 端还覆盖 Claude 会读取的运营商／SIM 元数据，内置英美日运营商预设。详见 [Android 文档](android/README.md)。

### macOS

需要 macOS 13+、Node.js 18+、未修改且 Anthropic 官方签名的 Claude。完全退出 Claude 后，在 `macos` 目录运行：

```sh
zsh 接管\ Claude\ 原入口.command
# 或
node src/cli.js install-wrapper
```

接管后，启动台、Dock、聚焦里的 Claude 原入口照常使用，进程与窗口名仍是 Claude；真正的官方 App 原样保留在隐藏的 `.ClaudeSpoof` 目录中。外壳只负责通过 LaunchServices 以 `TZ`／`--lang` 环境启动官方 App，不修改 ASAR、不重签、不看门狗。恢复时运行 `node src/cli.js remove-wrapper`。详见 [macOS 文档](macos/README.md)。

### Windows

需要 Windows 10／11、官方 MSIX 版 Claude、Node.js 22+。编辑 `windows/config.json`，再运行：

```bat
Start-ClaudeUK.cmd
```

Windows 版只在本次启动的新进程内工作，不写回官方 EXE／ASAR。首次运行会备份并接管当前用户开始菜单中的 `Claude.lnk`，以后可继续从开始菜单的 Claude 图标进入。已验证的英国后台实例会直接唤醒；官方直启或验证不匹配的实例会先退出，再以配置环境重启并完整检查主进程、Renderer、共享 provider、Cowork 服务身份和官方文件哈希。失败会关闭本次进程，不静默退回真实时区。

## 发布附件

三客户端汇总 Release 提供：

- `ClaudeSpoof-v1.5.1.apk`：Android 安装包。
- `ClaudeSpoof-macOS-v2.0.0.zip`：macOS 官方签名环境启动器、配置与文档。
- `ClaudeSpoof-Windows-v1.0.2.zip`：Windows 启动器、完整源码、配置与文档。
- `SHA256SUMS.txt`：桌面压缩包及 Android APK 的 SHA-256。

源码仓库不保存 Claude 官方安装包、ASAR、账号数据、Cookie、token、MCP 密钥或本机验证日志。

## 目录

```text
android/    Android LSPosed 模块与设置 App
macos/      macOS 官方签名环境启动器与配置工具
windows/    Windows 内存启动器、运行时覆盖与 VM 进程时区覆盖
art/        共享图标资源
LICENSE     GPL-3.0-or-later
```

## 验证与兼容边界

- Android 主要 hook 系统 API，通常不依赖 Claude 混淆类名。
- macOS 已在 Electron 45.3.3 上验证 Renderer 继承 `TZ` 与 `--lang`；真实客户端的设备密钥、会话关联和附加文件夹也已实测。接管后从原入口启动即继承环境；直接打开隐藏目录里的官方 App 不会继承。
- Windows 当前针对 Claude 6.28899.6.0 验证；共享模块或 VM 导出变化会触发失败保护，需要更新适配。
- Windows VM 覆盖针对由 Claude VM client 创建的进程；不会修改 VM 的 `/etc/localtime`、`/etc/timezone` 或独立系统服务。
- 时区、语言、运营商只是环境信号的一部分；出口 IP、账号资料、支付信息等仍可能独立存在。
- 本工具不等于隐身、隐私保护或网络请求阻断器。绕过区域限制可能违反服务条款，使用与账号风险由用户自行承担。

## 许可证

整个仓库采用 **GPL-3.0-or-later**，见 [LICENSE](LICENSE)。
