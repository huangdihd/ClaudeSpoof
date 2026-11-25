import AppKit
import Foundation

struct WrapperMarker: Decodable {
    let kind: String
    let realPath: String
    let appPath: String?
    let helperSource: String?
}

struct SpoofConfig: Decodable {
    let enabled: Bool?
    let timezone: String?
    let language: String?
}

final class LauncherDelegate: NSObject, NSApplicationDelegate {
    private let teamId = "Q6L2SF6YDW"
    private let hwKeyGroup = "Q6L2SF6YDW.com.anthropic.claude.hwkey"
    private var pendingURLs: [URL] = []
    private var launched = false

    func application(_ application: NSApplication, open urls: [URL]) {
        pendingURLs.append(contentsOf: urls)
        if launched {
            forwardURLsToRunning(urls)
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Give LaunchServices a brief moment to deliver any initial open-URL AppleEvents.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) {
            self.launched = true
            self.runLaunchFlow()
            NSApp.terminate(nil)
        }
    }

    private func stateHome() -> URL {
        if let envHome = ProcessInfo.processInfo.environment["CLAUDE_SPOOF_HOME"], !envHome.isEmpty {
            return URL(fileURLWithPath: envHome)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/ClaudeSpoof", isDirectory: true)
    }

    private func loadMarker() throws -> WrapperMarker {
        guard let url = Bundle.main.url(forResource: "ClaudeSpoofEnvironment", withExtension: "json") else {
            throw NSError(domain: "ClaudeSpoof", code: 1, userInfo: [NSLocalizedDescriptionKey: "缺少 ClaudeSpoofEnvironment.json 标记文件"])
        }
        let data = try Data(contentsOf: url)
        return try JSONDecoder().decode(WrapperMarker.self, from: data)
    }

    private func loadConfig() -> (enabled: Bool, timezone: String, language: String) {
        let cfgURL = stateHome().appendingPathComponent("config.json")
        if let data = try? Data(contentsOf: cfgURL),
           let cfg = try? JSONDecoder().decode(SpoofConfig.self, from: data) {
            return (
                cfg.enabled ?? true,
                (cfg.timezone?.isEmpty == false) ? cfg.timezone! : "Europe/London",
                (cfg.language?.isEmpty == false) ? cfg.language! : "en-GB"
            )
        }
        return (true, "Europe/London", "en-GB")
    }

    private func runProcess(_ launchPath: String, _ args: [String]) -> (status: Int32, output: String) {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: launchPath)
        proc.arguments = args
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = pipe
        do {
            try proc.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            proc.waitUntilExit()
            return (proc.terminationStatus, String(data: data, encoding: .utf8) ?? "")
        } catch {
            return (-1, error.localizedDescription)
        }
    }

    private func verifyOfficialSignature(realPath: String) throws {
        let verify = runProcess("/usr/bin/codesign", ["--verify", "--deep", "--strict", realPath])
        if verify.status != 0 {
            throw NSError(domain: "ClaudeSpoof", code: 2, userInfo: [NSLocalizedDescriptionKey: "官方签名校验失败：\n\(verify.output)"])
        }
        let info = runProcess("/usr/bin/codesign", ["-dv", "--verbose=4", realPath])
        if !info.output.contains("TeamIdentifier=\(teamId)") {
            throw NSError(domain: "ClaudeSpoof", code: 3, userInfo: [NSLocalizedDescriptionKey: "Claude 不是 Anthropic 官方签名（缺少 TeamIdentifier=\(teamId)）"])
        }
        let ent = runProcess("/usr/bin/codesign", ["-d", "--entitlements", ":-", "--xml", realPath])
        if !ent.output.contains("<string>\(hwKeyGroup)</string>") {
            throw NSError(domain: "ClaudeSpoof", code: 4, userInfo: [NSLocalizedDescriptionKey: "Claude 缺少硬件密钥访问组：\(hwKeyGroup)"])
        }
    }

    private func posixLocale(for language: String) -> String {
        let normalized = language.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = normalized.lowercased()
        let scriptMap: [String: String] = [
            "zh-hans": "zh_CN", "zh-hant": "zh_TW", "zh": "zh_CN",
            "en": "en_US", "ja": "ja_JP", "ko": "ko_KR",
            "fr": "fr_FR", "de": "de_DE", "es": "es_ES", "pt": "pt_BR"
        ]
        if let mapped = scriptMap[lower] { return "\(mapped).UTF-8" }
        let parts = normalized.split(separator: "-").map(String.init)
        if parts.count >= 2 {
            let lang = parts[0].lowercased()
            if let region = parts.dropFirst().first(where: { $0.count == 2 && $0.allSatisfy(\.isLetter) }) {
                return "\(lang)_\(region.uppercased()).UTF-8"
            }
        }
        return "\(normalized.replacingOccurrences(of: "-", with: "_")).UTF-8"
    }

    private func appleLocale(for language: String) -> String {
        let posix = posixLocale(for: language)
        return posix.hasSuffix(".UTF-8") ? String(posix.dropLast(6)) : posix
    }

    private func runningRealApps(realPath: String) -> [NSRunningApplication] {
        let targetBundleURL = URL(fileURLWithPath: realPath).standardizedFileURL
        return NSWorkspace.shared.runningApplications.filter { app in
            guard let url = app.bundleURL?.standardizedFileURL else { return false }
            return url == targetBundleURL
        }
    }

    private func forwardURLsToRunning(_ urls: [URL]) {
        guard !urls.isEmpty, let marker = try? loadMarker() else { return }
        var args = ["-a", marker.realPath]
        args.append(contentsOf: urls.map(\.absoluteString))
        _ = runProcess("/usr/bin/open", args)
    }

    private func showAlert(title: String, message: String, buttons: [String] = ["好"]) -> NSApplication.ModalResponse {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = title
        alert.informativeText = message
        for button in buttons { alert.addButton(withTitle: button) }
        return alert.runModal()
    }

    private func runLaunchFlow() {
        do {
            let marker = try loadMarker()
            let realPath = marker.realPath
            let config = loadConfig()
            try verifyOfficialSignature(realPath: realPath)

            if !config.enabled {
                let resp = showAlert(
                    title: "ClaudeSpoof 已停用",
                    message: "当前配置为已停用状态。是否以系统真实时区与语言直接打开官方 Claude？",
                    buttons: ["取消", "以真实环境打开"]
                )
                if resp == .alertSecondButtonReturn {
                    var args = [realPath]
                    args.append(contentsOf: pendingURLs.map(\.absoluteString))
                    _ = runProcess("/usr/bin/open", args)
                }
                return
            }

            let running = runningRealApps(realPath: realPath)
            if let existing = running.first {
                existing.activate(options: [.activateIgnoringOtherApps])
                if !pendingURLs.isEmpty {
                    var args = ["-a", realPath]
                    args.append(contentsOf: pendingURLs.map(\.absoluteString))
                    _ = runProcess("/usr/bin/open", args)
                }
                return
            }

            // Refuse if an unverified Claude process from another path is running.
            let anyClaude = NSWorkspace.shared.runningApplications.filter {
                $0.executableURL?.lastPathComponent == "Claude"
            }
            if !anyClaude.isEmpty {
                _ = showAlert(
                    title: "无法启动 ClaudeSpoof",
                    message: "检测到已在运行的未验证 Claude 进程。请先完全退出 Claude，再重新打开。"
                )
                return
            }

            let posix = posixLocale(for: config.language)
            let appleLoc = appleLocale(for: config.language)
            var args = [
                "--env", "TZ=\(config.timezone)",
                "--env", "LANG=\(posix)",
                "--env", "LC_ALL=\(posix)",
                "--env", "LANGUAGE=\(config.language)",
                realPath
            ]
            args.append(contentsOf: pendingURLs.map(\.absoluteString))
            args.append(contentsOf: [
                "--args",
                "--lang=\(config.language)",
                "-AppleLanguages", "(\"\(config.language)\")",
                "-AppleLocale", appleLoc
            ])

            let openResult = runProcess("/usr/bin/open", args)
            if openResult.status != 0 {
                throw NSError(domain: "ClaudeSpoof", code: 5, userInfo: [NSLocalizedDescriptionKey: "open 启动失败：\n\(openResult.output)"])
            }
        } catch {
            _ = showAlert(title: "ClaudeSpoof 启动失败", message: error.localizedDescription)
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = LauncherDelegate()
app.delegate = delegate
app.run()
