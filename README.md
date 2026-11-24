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
| macOS | 1.1.5 | ASAR 主入口注入、完整性修复、ad-hoc 重签、更新看门狗 | 修改并备份，可还原 | [macos/README.md](macos/README.md) |
| Windows | 1.0.0 | 官方进程内存启用临时调试入口，运行时注入并校验 | 不修改 | [windows/README.md](windows/README.md) |

## 快速开始

### Android

1. 安装 APK，在 LSPosed 中启用模块，作用域只选择 Claude。
2. 强行停止并重新打开 Claude。
3. 在 ClaudeSpoof 设置界面配置时区、语言和运营商。

Android 端还覆盖 Claude 会读取的运营商／SIM 元数据，内置英美日运营商预设。详见 [Android 文档](android/README.md)。

### macOS

需要 macOS 13+、Node.js 18+。完全退出 Claude 后，在 `macos` 目录运行：

```sh
zsh 安装自动补丁.command
```

首次运行会通过 `npm ci` 安装锁定依赖。安装后可以使用 `接管 Claude 图标.command`，让原图标先检查补丁再启动。

> macOS 会修改并重签 App。请阅读文档中的 Keychain、TCC、hardened runtime 和升级注意事项，并先备份完整 Claude.app。

### Windows

需要 Windows 10／11、官方 MSIX 版 Claude、Node.js 22+。完全退出 Claude 后，编辑 `windows/config.json`，再运行：

```bat
Start-ClaudeUK.cmd
```

Windows 版只在本次启动的新进程内工作，不写回官方 EXE／ASAR。启动后会检查主进程、Renderer、共享 provider、Cowork 服务身份和官方文件哈希；失败会关闭本次进程，不静默退回真实时区。

## 发布附件

三客户端汇总 Release 提供：

- `ClaudeSpoof-v1.5.1.apk`：Android 安装包。
- `ClaudeSpoof-macOS-v1.1.5.zip`：macOS 源码、安装脚本、配置与文档。
- `ClaudeSpoof-Windows-v1.0.0.zip`：Windows 启动器、完整源码、配置与文档。
- `SHA256SUMS.txt`：桌面压缩包及 Android APK 的 SHA-256。

源码仓库不保存 Claude 官方安装包、ASAR、账号数据、Cookie、token、MCP 密钥或本机验证日志。

## 目录

```text
android/    Android LSPosed 模块与设置 App
macos/      macOS 自动补丁器、更新看门狗与原图标启动器
windows/    Windows 内存启动器、运行时覆盖与 VM 进程时区覆盖
art/        共享图标资源
LICENSE     GPL-3.0-or-later
```

## 验证与兼容边界

- Android 主要 hook 系统 API，通常不依赖 Claude 混淆类名。
- macOS 会动态识别 ASAR 主入口，但签名、Keychain、权限和未来 Squirrel 更新仍受系统与新版影响。
- Windows 当前针对 Claude 6.28899.6.0 验证；共享模块或 VM 导出变化会触发失败保护，需要更新适配。
- Windows VM 覆盖针对由 Claude VM client 创建的进程；不会修改 VM 的 `/etc/localtime`、`/etc/timezone` 或独立系统服务。
- 时区、语言、运营商只是环境信号的一部分；出口 IP、账号资料、支付信息等仍可能独立存在。
- 本工具不等于隐身、隐私保护或网络请求阻断器。绕过区域限制可能违反服务条款，使用与账号风险由用户自行承担。

## 许可证

整个仓库采用 **GPL-3.0-or-later**，见 [LICENSE](LICENSE)。
