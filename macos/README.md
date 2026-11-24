# ClaudeSpoof：macOS 时区／语言补丁与更新看门狗

针对用户自行持有的 Claude macOS Electron 客户端。补丁只修改主进程入口，用独立配置覆盖时区和语言；不读取、复制或外发 Claude 的 Cookie、OAuth token、聊天记录及账号目录。

> 发布版本：**1.1.5**。默认配置为 `Europe/London`／`en-GB`。已在真实 Mac 的 Claude **6.28899.6** 上验证运行时启动、主进程与 Renderer 时区覆盖以及原图标接管；另用 Claude **4.23118.0** 的 `app.asar` 与 `Info.plist` 完成静态往返、完整性、模拟更新和还原测试。本版的注入 v3 增加登录后 locale 冲突兼容，并要求实测值与配置一致。Keychain、系统权限和后续 Squirrel 更新仍可能受本机环境影响，第一次使用请先保留完整 App 副本。

## 它能做什么

- 从 ASAR 内的 `package.json` 动态寻找主入口，不依赖带哈希的 chunk 文件名。
- 在主进程启动早期设置 `TZ`，覆盖 Electron 语言 API。
- 通过 Electron 内部调试器向 Renderer 下发时区、locale 和 Accept-Language 覆盖，不开放外部调试端口。
- 同时更新：
  - ASAR 整体 `headerString` 的 SHA-256；
  - 被改入口的逐文件 SHA-256 与分块哈希；
  - `Info.plist` 中的 `ElectronAsarIntegrity`。
- 保留其他 packed 文件、unpacked 原生模块、链接和可执行标记。
- 官方更新覆盖后，通过 LaunchAgent 自动重新识别并补丁。
- 补丁前备份当前版本，失败自动还原；保留最近两份备份。
- 重签时保留原 designated requirement，不关闭或绕过 Squirrel 的更新签名校验。
- 仅移除 ad-hoc 签名无法兑现的三个团队绑定 entitlement，保留 JIT、virtualization 及其余原权限声明。
- 1.1.3 起为修改版主进程添加 `disable-library-validation`，以加载仍保留 Anthropic 原签名的 Electron Framework，不重签嵌套 Framework。

## 准备

1. macOS 13 或更新版本。
2. Node.js 18 或更新版本。若使用 Homebrew：

   ```sh
   brew install node
   ```

3. 首次运行安装脚本时会自动执行 `npm ci`，只安装 `package-lock.json` 中锁定的依赖；也可以提前在工具目录手动执行。
4. 完全退出 Claude。
5. 解压本工具到一个以后不会移动的位置。LaunchAgent 记录的是绝对路径；移动文件夹后需重新安装。
6. 建议先备份完整 App，例如在“终端”执行：

   ```sh
   ditto /Applications/Claude.app "$HOME/Applications/Claude 原始备份.app"
   ```

   如果 `$HOME/Applications` 不存在，先创建它。

## 安装

默认目标是 `/Applications/Claude.app`。在工具目录执行：

```sh
zsh 安装自动补丁.command
```

也可以双击该脚本。它会立即补丁，并安装用户级 LaunchAgent。不要用 `sudo` 运行；若 `/Applications` 中的 App 不可写，建议把副本放到 `$HOME/Applications` 后对该副本安装。

若你使用的是“Claude 修改版.app”副本：

```sh
zsh 安装自动补丁.command "/Applications/Claude 修改版.app"
```

也可以先执行 `npm ci`，再运行：

```sh
node src/cli.js install --app "/Applications/Claude 修改版.app"
```

## 修改配置

双击 `修改时区语言.command`，或执行：

```sh
node src/cli.js config --timezone Europe/London --language en-GB
node src/cli.js config --timezone Asia/Tokyo --language en-US
node src/cli.js config --timezone America/New_York --language en-US
```

配置保存在：

```text
~/Library/Application Support/ClaudeSpoof/config.json
```

完全退出并重开 Claude 后生效。改配置不需要重新 patch。

其他示例：

```sh
# 暂时停用全部伪装，但保留补丁和看门狗
node src/cli.js config --enabled false

# 恢复启用
node src/cli.js config --enabled true

# 不修改 Renderer 的 Accept-Language
node src/cli.js config --accept-language false
```

### 语言的实际边界

- 系统语言 API、`window.desktopPreferredLanguages` 的输入和 Renderer locale 会使用配置值。
- Claude 4.23118.0 的本地界面自动选择器仅接受 `en-US`、`de-DE`、`fr-FR`、`ko-KR`、`ja-JP`、`es-419`、`es-ES`、`it-IT`、`hi-IN`、`pt-BR`、`id-ID`。
- Claude 内已经保存的手动语言设置优先于系统自动匹配。
- 因此 `zh-Hans`／`zh-Hant` 会传给相关 API，但不能保证本地菜单自动变成中文；远程页面是否采用该语言还取决于页面自身和账号设置。

## 启动与更新后的行为

如果不接管原图标，可以用下面的入口启动，它会在打开前再检查一次：

```sh
zsh 启动 Claude.command
```

### 让原来的 Claude 图标自动走启动器

安装补丁后执行：

```sh
zsh 接管 Claude 图标.command
```

它会：

1. 把真正的 App 移到同目录的隐藏路径 `.Claude 原版.app`，程序内容不因此改变；
2. 在原来的 `/Applications/Claude.app` 位置创建同名、同图标的 AppleScript 启动器；
3. 点击原图标时先执行补丁检查，再打开隐藏的真实 Claude；
4. 把更新看门狗和状态文件迁移到真实 App 的新路径。

启动器使用 `osacompile` 在本机生成并进行 ad-hoc 签名，不需要 Xcode。补丁失败或真实 App 丢失时会弹窗，不会静默忽略错误。

注意：它接管的是**原路径和原图标**。已经指向真实 App 移动后路径的 Dock 项、登录项，或手动直接打开 `.Claude 原版.app`，仍可能绕过启动器；如果旧 Dock 图标没有走启动器，请移除后重新固定原位置的 Claude。启动器和真实 Claude 的 bundle identifier 不同，Dock 可能分别显示两个图标。

只恢复原图标、保留补丁与看门狗：

```sh
zsh 恢复原 Claude 图标.command
```

`检查状态.command`、`启动 Claude.command` 和 `还原并卸载.command` 会自动识别外层启动器，不需要手动填写隐藏路径。

看门狗同时采用：

- 监听 `Contents/Resources/app.asar` 与 `Contents/Info.plist` 的路径变化；
- 每 5 分钟检查一次；
- 启动脚本主动检查。

发现官方新版后：

1. 若 Claude 正在运行，不强制退出，只通知并等待；
2. Claude 退出后自动备份、重 patch、更新完整性并重签；
3. 下次启动生效。

如果更新器要求重启安装，可以继续使用官方流程。补丁器不会删除更新、修改更新服务器或跳过官方签名验证。

## 检查状态

```sh
zsh 检查状态.command
```

正常补丁状态应包含：

```json
{
  "injectionVersion": 3,
  "mainIntegrityMatches": true,
  "integrityMatches": true
}
```

`check` 只证明文件层面的补丁和完整性，不等于真实运行时端到端验证。

可在 Cowork／本地 Agent 中让它执行以下命令检查时区：

```sh
date
node -p "process.env.TZ"
node -p "Intl.DateTimeFormat().resolvedOptions().timeZone"
```

不要把“模型口头回答的时区”当作验证结果。

## 日志

```text
~/Library/Application Support/ClaudeSpoof/agent.stdout.log
~/Library/Application Support/ClaudeSpoof/agent.stderr.log
```

补丁状态与备份清单位于同一目录。这里不是 Claude 的账号数据目录。

## 还原与卸载

先完全退出 Claude，然后：

```sh
zsh 还原并卸载.command
```

它会移除看门狗，并恢复最近一次补丁前的 `app.asar`、`Info.plist`、主可执行文件和签名目录。为避免把不同版本混在一起，版本或哈希不匹配时会拒绝还原。

只移除看门狗、保留当前文件：

```sh
node src/cli.js uninstall-agent
```

如果官方更新已经覆盖成未补丁版，而你只是想卸载工具，应使用上面的 `uninstall-agent`，不要强行把旧备份盖到新版上。

## 签名与系统权限注意事项

- Apple Silicon 上修改后通常需要重签。本工具使用本机 ad-hoc 签名，并保留 requirements、flags 和 runtime 元数据。
- 1.1.1 保留的三个团队绑定项会被 AMFI 拒绝，表现为 `RBSRequestErrorDomain Code=5`、`NSPOSIXErrorDomain Code=153`。1.1.2 仅移除 `com.apple.application-identifier`、`com.apple.developer.team-identifier` 和 `keychain-access-groups`，其余 entitlements 逐项比对并保留。
- 保留项包括 `com.apple.security.cs.allow-jit` 和 `com.apple.security.virtualization`，避免破坏 Electron/V8 与 Cowork；不使用 `--deep`，也不清空全部 entitlements。
- 1.1.2 的真实崩溃报告显示主进程的 ad-hoc Team ID 与 Electron Framework 的 Developer ID Team ID 不同，触发 hardened runtime 库验证。1.1.3 添加 `com.apple.security.cs.disable-library-validation=true`，嵌套 Framework 保持原签名，hardened runtime 保留。
- **安全取舍**：`disable-library-validation` 会削弱修改版主进程的库注入防护，允许加载不同 Team ID 或未按原策略验证的本地库。它不关闭 SIP、Gatekeeper 或官方更新签名校验，但仍然是权限放宽；只应在你信任本机 App 目录及其中原生模块的前提下使用。
- 移除 Keychain 共享组后，硬件 passkey／WebAuthn 安全密钥及微软工作账户相关 Keychain 集成功能可能不可用，普通登录也可能需要重新授权。此操作不删除 Claude 聊天或账号数据。
- ad-hoc 签名不等同于 Anthropic 的 Developer ID 签名，也不能通过 Gatekeeper 的开发者身份验证。
- 即使保留 designated requirement，当前修改版仍可能无法满足 Anthropic 证书要求；Keychain、Cookie 加密、TCC 权限、登录项或登录状态可能受影响，可能需要重新登录或授权。
- Squirrel.Mac 会依据当前 App 的 designated requirement 验证新包。本工具会比对重签前后的 requirements，不一致就失败并还原；但真实官方更新链路仍须在你的 Mac 上实测。
- 不重签嵌套 Framework，也不使用 `--deep` 重签，避免扩大修改范围。嵌套代码仍参与严格验证。
- macOS 的 `codesign --verify -R …` 会同时检查显式 requirement 和原 designated requirement。因此，保留 Anthropic 原 DR 的 ad-hoc 修改版会出现“valid on disk / explicit requirement satisfied / does not satisfy its designated Requirement”。验证器只接受这一组完全匹配的已知结果；只要多出资源损坏、嵌套代码失败或缺少必要验证行，仍会失败并自动还原。

### 从旧版修复启动失败

将 1.1.5 文件覆盖到原工具目录，确保 LaunchAgent 不会继续指向旧副本。完全退出 Claude，然后双击：

```sh
zsh 修复启动失败.command
```

也可以执行：

```sh
node src/cli.js repair-sign --app /Applications/Claude.app
```

该命令会自动识别外层启动器并修复隐藏的真实 App。它只重签，不改写 `state.lastBackup` 指向的官方还原备份；执行期间另建临时安全副本，成功或回滚后删除，回滚失败则保留并报告路径。

## 失败保护

以下情况会停止，而不是猜测着改：

- 主入口或 `package.json` 不存在；
- ASAR 整体哈希与 `Info.plist` 不一致；
- 主入口逐文件完整性不匹配；
- 出现不支持的 ASAR 完整性算法；
- 重签前后 designated requirement 变化；
- 最终补丁验证失败；
- 另一个补丁／还原操作正在执行。

备份最多保留两份，每份约等于一个 `app.asar` 的大小，另加少量签名文件。

## 命令行参考

```sh
node src/cli.js check   --app /Applications/Claude.app
node src/cli.js patch   --app /Applications/Claude.app
node src/cli.js repair-sign --app /Applications/Claude.app
node src/cli.js start   --app /Applications/Claude.app
node src/cli.js install-launcher   --app /Applications/Claude.app
node src/cli.js uninstall-launcher --app /Applications/Claude.app
node src/cli.js restore --app /Applications/Claude.app
node src/cli.js config
```

`--no-sign` 和 `--skip-process-check` 只用于非 macOS 静态测试，不应在日常安装中使用。

## 本次已完成的静态测试

使用实际上传的 4.23118.0 文件：

- 原包所有 994 个 packed 文件完整性校验通过；
- 补丁后仅主入口内容变化，其余 993 个非目标 packed 文件逐一 SHA-256 一致；
- unpacked、link、executable 元数据保留；
- 主入口 JavaScript 语法检查通过；
- ASAR 整体与逐文件完整性校验通过；
- 重复执行不重复注入；
- 模拟官方更新后自动识别并重 patch；
- 还原恢复当前新版备份，而非旧版；
- 模拟 Renderer 中成功下发 timezone、locale 和 Accept-Language 覆盖；
- 操作锁可防止看门狗与启动脚本同时改写；
- 启动器的路径接管、状态迁移、恢复原图标和创建失败回滚已通过隔离模拟，CLI 能自动解析外层启动器路径。

真实 Mac 已在 Claude 6.28899.6 上验证启动、AppleScript 原图标接管、主进程和 Renderer 时区覆盖。Keychain、TCC 权限、登录状态与未来官方更新仍受本机环境和新版客户端影响，不能视为永久兼容保证。

## 参考

- [Squirrel.Mac：更新包按当前 App 的 designated requirement 验证](https://github.com/Squirrel/Squirrel.Mac/blob/master/Squirrel/SQRLCodeSignature.m)
- [Electron：macOS Code Signing](https://electronjs.org/docs/latest/tutorial/code-signing)
- [Apple：Inside Code Signing—Requirements](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)

## 许可证

GPL-3.0-or-later，见 [LICENSE](LICENSE)。
