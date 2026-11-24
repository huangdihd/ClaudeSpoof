# ClaudeSpoof Windows：运行时英国时区／语言启动器

针对用户自行安装的 Claude Windows MSIX 客户端。默认把 Claude 主进程、Renderer 以及由 Claude VM client 创建的进程设置为 `Europe/London`／`en-GB`，不修改 Windows 系统时区。

本包不包含 Claude 官方程序、账号数据、Cookie、OAuth token、聊天记录、MCP 密钥或任何远端服务器配置。

## 已验证版本与边界

- 已验证官方 Claude **6.28899.6.0**。
- 官方 `Claude.exe` 的 Authenticode 签名在运行前后保持有效，SHA-256 不变。
- Windows 系统时区保持不变；主进程、Renderer 和共享时区 provider 使用配置值。
- 已实测 Cowork VM 默认一次性进程、Cowork 同等环境调用、VM 停止并重启后的进程。
- VM 进程统一获得 `TZ=Europe/London`；VM 的 `/etc/localtime`、`/etc/timezone` 和独立系统守护进程不修改，因此 `/etc/timezone` 仍可能显示 `Etc/UTC`。
- 不包含 Chrome 扩展补丁，也不是 Anthropic 网络请求或遥测阻断器。

## 要求

1. Windows 10／11，已安装官方 MSIX 版 Claude。
2. Node.js **22 或更新版本**，并确保 `node` 在 PATH 中。
3. 正常运行启动器需要交互式桌面会话；不要通过普通 SSH 服务会话直接启动 GUI。
4. 完全退出 Claude，包括托盘和后台进程。

## 使用

1. 解压到一个稳定目录，不要只解压部分文件。
2. 按需编辑 `config.json`。默认：

   ```json
   {
     "enabled": true,
     "timezone": "Europe/London",
     "language": "en-GB",
     "overrideAcceptLanguage": true,
     "verifyCoworkVm": false,
     "configureCoworkVm": false,
     "restartCoworkVm": false
   }
   ```

3. 双击 `Start-ClaudeUK.cmd`，或在当前目录执行：

   ```bat
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-ClaudeUK.ps1
   ```

4. 启动器会寻找最新安装的官方 MSIX 包，检查签名、启动官方进程、执行内存注入并核验结果。
5. 检查成功后会留下 `last-launch-verification.json`。日常使用不需要管理员权限，也不需要编译 C#。

如需桌面入口，可让快捷方式指向解压目录中的 `Start-ClaudeUK.cmd`。移动目录后，重新创建旧快捷方式即可。

## 文件说明

- `MemoryFuseLauncher.exe`：已测试的 x64 Windows 启动器。
- `MemoryFuseLauncher.cs`：上述启动器的完整源码。
- `Start-ClaudeUK.ps1`：官方版本发现、签名／哈希检查、运行时校验与失败清理。
- `inspect_client.js`：连接临时的回环调试器，在官方 launcher 调用帧中执行注入。
- `runtime-probe.js`：主进程、Renderer、共享 provider 与 VM spawn 的运行时覆盖和验证。
- `config.json`：用户配置；三个一次性 VM 测试开关日常必须保持 `false`。

## 工作方式与安全边界

- 启动器挂起创建官方 `Claude.exe`，只在新进程的内存中把 Electron `nodeCliInspect` fuse 从 `0` 改为 `1`，不写回官方 EXE 或 ASAR。
- 注入完成后关闭临时调试端口 `127.0.0.1:19229`。
- 若签名校验、provider、Renderer、Cowork 服务身份或运行时检查失败，会结束本次由启动器创建的官方进程，而不是静默使用真实系统时区。
- 进程内存补丁和回环调试器可能触发安全软件告警；发布包同时提供完整 C# 与 JavaScript 源码以便审计。
- 运行时目录会生成本地验证 JSON，不包含聊天内容或账号凭据。

## VM 自动校验

VM watcher 每约 5 秒检查一次连接状态，只在发现 VM 已连接后执行一次本地时区检查。它不会为了验证而自动启动 VM；失败后至少等待 30 秒。结果写入 `vm-auto-verification.json`。

该覆盖只对经过 Claude VM client 创建的进程生效。直接修改 VM 基础系统文件需要 root，而当前 VM 实测会拒绝普通用户写入并禁止 `sudo` 提权，因此本方案不采用镜像修改或提权。

## 官方更新

脚本会动态寻找最新 MSIX 安装目录，但当前共享模块名和 VM 导出别名仍属于版本相关实现。更新后如果模块缺失或不匹配，启动器会报错并结束本次进程；这属于预期的失败保护，不是自动兼容所有未来版本。

不要用旧验证文件判断新版本是否安全。更新后应重新进行一次完整启动检查。

## 卸载

完全退出 Claude，删除本工具目录及自行创建的快捷方式即可。官方 Claude 文件没有被本方案改写，因此不需要恢复官方 EXE 或 ASAR。

如需彻底恢复未注入状态，直接从官方入口重新启动 Claude；此时客户端会使用系统真实环境。

## 源码重编译（可选）

仅在需要自行构建启动器时，使用 Windows SDK／.NET Framework 自带的 C# 编译器：

```bat
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /optimize+ /platform:x64 /target:exe /out:MemoryFuseLauncher.exe MemoryFuseLauncher.cs
```

发布包中的 EXE 已与上述源码的已测试版本配套。重编译后请重新验证哈希、启动和失败保护。

## 许可证

GPL-3.0-or-later，见 [LICENSE](LICENSE)。
