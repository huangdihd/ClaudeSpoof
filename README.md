# ClaudeSpoof — Claude 安卓端时区 / 语言伪装模块

基于 Claude **1.261104.19**（versionCode 26110419）逆向分析编写的 LSPosed 模块，
让 Claude 进程内所有"读系统时区 / 语言"的调用返回你设定的值。
**v1.1 起带设置界面，时区 / 语言 / 开关在模块 App 里直接改，保存后约 5 秒生效。**
**v1.4 起设置界面改用 Material 3（Material You，Android 12+ 动态取色）。**

## 使用

1. 编译安装本模块（构建方法见下文），桌面会出现 **ClaudeSpoof** 图标。
2. 在 LSPosed 中启用模块，**作用域只勾选 Claude**（manifest 已声明 scope）。
3. 对 Claude **强行停止**后重新打开（首次加载模块必须重启进程）。
4. 打开 ClaudeSpoof，设置：
   - **时区**：IANA 时区 ID，如 `America/New_York`（建议与代理出口一致）
   - **语言**：BCP-47 标签，如 `en-US`
   - **启用伪装**：总开关，关闭后 Claude 读到真实系统值
5. 保存后约 5 秒内自动生效，一般无需重启 Claude；未生效就强杀重开。

## 验证

- LSPosed 日志出现：`ClaudeSpoof: active in process ... tz=... lang=...`
- 抓包对比发消息请求体：`sender_timezone` 应变成设定的时区。
- 模块只对 Claude 进程生效，不影响系统和其他 App。

## Claude 更新后还能用吗？

**大概率能，无需跟进版本。** 模块 hook 的全部是 Android **系统 API**
（`java.util.TimeZone`、`java.time.ZoneId`、`Locale`、`LocaleList`、
`Configuration`、`android.icu`、`SystemProperties`），**不依赖 Claude 的
混淆类名、内部类结构或网络字段名**。只要 Claude 还通过标准 API 读时区/语言，
换版本、换混淆名、改 `sender_timezone` 字段名都不影响本模块。

可能失效的情形（届时需要升级模块思路）：

- 官方改为 **native 层**直接读取（C/C++ 调 ICU/libc，Java hook 够不到）；
- 官方改为**服务器侧**根据 IP 等推断时区，不再信任本地上报；
- 官方加入 Xposed/hook 检测并拒绝运行。

验证方法不变：更新后看 LSPosed 日志是否有 `active` 行，抓包看 `sender_timezone`。

## 逆向结论（v1.0 分析依据）

| 用途 | 代码位置（混淆名） | 实际调用 |
| --- | --- | --- |
| 时区 ID（getCurrentTimezoneId） | `defpackage.ts0.g()` | `java.util.TimeZone.getDefault().getID()` |
| 时区偏移（分钟） | `defpackage.ts0.c()` | `TimeZone.getDefault().getOffset(now)` |
| kotlinx 时区对象 | `defpackage.neg` 接口默认方法 | `java.time.ZoneId.systemDefault()` |
| 语言 | `ClaudeApplication`、各 Service 等 | `Locale.getDefault()` / `LocaleList.getDefault()` |

上报字段：

- 聊天发送请求 `com.anthropic.claude.sessions.types.SendChannelMessageRequest` → **`sender_timezone`**
- 语音会话 `com.anthropic.voice.internal.conversation.fb` → `timezone`
- Segment 分析埋点（`defpackage.gs0`）→ `time_zone`、`device_locale`
- HTTP 请求头 `Accept-Language`（由 Locale 派生）

大量 `ZoneId.systemDefault()` 调用点是 kotlinx-datetime 的
`TimeZone.currentSystemDefault()` 被 R8 内联的结果，不存在统一业务入口，
所以模块选择 hook 系统 API——一次覆盖全部路径，也天然抗版本更新。

## 配置传递实现

设置界面写 `SharedPreferences("config")`，Claude 进程内通过
`XSharedPreferences` 读取（LSPosed 支持跨进程读取）。每次被 hook 调用前
检查缓存，超过 3 秒才 `reload()`，开销可忽略；读取失败沿用上一次值，
从未保存过则用 `SpoofConfig` 里的兜底默认值。

v1.2 起读取改为**双通道**：`XSharedPreferences` 与 `ContentProvider`
（`content://com.arin.claudespoof.config/config`）互备，任一通道成功即采用。

## 构建

1. Android Studio **Open** 打开本目录，同步后 **Build → Build APK(s)**。
2. 或命令行（Gradle 8.x + Android SDK 34）：
   ```bash
   gradle :app:assembleRelease
   ```
   产物在 `app/build/outputs/apk/release/app-release.apk`。
3. 若 `de.robv.android.xposed:api:82` 拉取失败（api.xposed.info 国内不稳定），
   手动下载 XposedBridgeApi.jar 放入 `app/libs/`，把 `app/build.gradle`
   里的依赖改为 `compileOnly files('libs/XposedBridgeApi.jar')`。

## 版本历史

- **v1.4**：设置界面 Material 3 重设计（AppBar + 卡片 + 描边输入框 + MaterialSwitch，Android 12+ 动态取色）。
- **v1.3**：配置读取双通道、per-app 语言 API 补全。
- **v1.1**：加入设置界面。
- **v1.0**：首版，hook 系统时区 / 语言 API。

## 限制与提醒

- 针对 1.261104.19 分析；兼容性判断见上文"Claude 更新后还能用吗"。
- **时区/语言只是风控信号之一**：出口 IP、账号注册资料、手机号归属地、
  支付信息等都可能参与判定，本模块不等于"隐身"。
- `LANGUAGE_TAG` 会影响 Claude 界面语言与 Accept-Language。
- 绕过应用的区域限制可能违反 Anthropic 用户协议，账号风险自担。

## 许可证

GPL-3.0-or-later，见 [LICENSE](LICENSE)。
