#if os(macOS) && DEBUG
import AppKit
import HimawariCore
import HimawariDesign
import HimawariShell
import SwiftUI

enum MacDemoScene: String, CaseIterable {
    case inputBar = "mac-1-input-bar"
    case inputBarAnswer = "mac-1b-input-bar-answer"
    case dropFile = "mac-2-drop-file"
    case checklist = "mac-3-checklist"
    case checklistOpen = "mac-3b-checklist-one-by-one"
    case panel = "mac-4-panel"
    case panelQuiet = "mac-4b-panel-nothing-waiting"
    case panelNotice = "mac-4c-panel-notice"
    case panelNoticesOpen = "mac-4d-panel-notices-open"
    case settings = "mac-6-settings"
    case settingsShortcutTaken = "mac-6b-settings-shortcut-taken"
    case settingsMessagesOn = "mac-6c-settings-messages-on"
    case settingsMessagesNoAccess = "mac-6d-settings-messages-no-access"
    case pairing = "mac-7-pairing"

    static let argument = "-HimawariMacDemo"

    static var requestedOutput: URL? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: argument), arguments.indices.contains(index + 1) else { return nil }
        return URL(fileURLWithPath: arguments[index + 1], isDirectory: true)
    }
}

@MainActor
enum MacDemo {
    static let answerSentence = "配对超时后 transport 先把 request 置空，第二行的强制解包 request! 就在空值上崩了。把 sign 的结果用 guard let 接住，失败时直接把状态改成 .expired 再返回。"
    static let sentence = "田中把周五的会改到 15:00\n出门提醒要跟着改吗"

    static func home() -> HomeSnapshot {
        let json = """
        {"items":[{"key":"demo:1","kind":"approval","awaitsOwner":true,"sentence":"\(sentence.replacingOccurrences(of: "\n", with: "\\n"))","actions":[
          {"action":"denied","label":"不用","polarity":"negative","ownerPresence":false,"binding":"a"},
          {"action":"approved","label":"改到 9:40","polarity":"positive","ownerPresence":false,"binding":"b"}]}],
         "awaitingCount":1,"revision":"demo"}
        """
        return try! JSONDecoder().decode(HomeSnapshot.self, from: Data(json.utf8))
    }

    static let notices = [
        DeviceNotification(
            id: "demo-notice-3",
            kind: "run_result",
            title: "大阪两天的行程表做好了",
            body: "放在文稿 / 旅行 里，酒店和新干线都按你上次的偏好选的",
            homeKey: nil,
            createdAt: "2026-11-15T05:35:00.000Z"
        ),
        DeviceNotification(
            id: "demo-notice-2",
            kind: "mail_reminder",
            title: "ANA 发来改签确认",
            body: "11 月 21 日 NH 23 改到 10:30 起飞",
            homeKey: nil,
            createdAt: "2026-11-15T03:12:00.000Z"
        ),
        DeviceNotification(
            id: "demo-notice-1",
            kind: "run_result",
            title: "上周的发票都归好档了",
            body: "12 张，放在文稿 / 发票",
            homeKey: nil,
            createdAt: "2026-11-15T01:48:00.000Z"
        ),
    ]

    static func settings(seesMessages: Bool = false) -> MacAccessSettings {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return MacAccessSettings(
            folders: [
                FolderGrant(id: "d", path: home.appendingPathComponent("Downloads").path, access: .readWrite),
                FolderGrant(id: "w", path: home.appendingPathComponent("Documents").path, access: .read),
            ],
            apps: [
                AppGrant(bundleId: "com.apple.finder", name: "访达"),
                AppGrant(bundleId: "com.apple.iCal", name: "日历"),
                AppGrant(bundleId: "com.apple.reminders", name: "提醒事项"),
            ],
            seesMessages: seesMessages
        )
    }

    static let checklist = ChangeList(
        id: "demo",
        title: "整理“下载”文件夹\n要动 44 个文件",
        rows: [
            ChangeRow(icon: "folder-symlink", text: "移动 38 个", note: "到 文稿 / 发票、报价、截图"),
            ChangeRow(icon: "pencil", text: "改名 6 个", note: "名字前加上日期"),
            ChangeRow(icon: "trash", text: "删除 0 个", note: "要删会单独问你"),
        ],
        items: [
            "发票_ANA_1028.pdf → 文稿 / 发票",
            "报价单 11 月.xlsx → 文稿 / 报价",
            "截屏 2026-11-12 10.31.04.png → 文稿 / 截图",
            "IMG_2231.HEIC → 2026-11-02 IMG_2231.HEIC",
        ]
    )

    static func view(for scene: MacDemoScene) -> AnyView {
        let app = AppModel.demo(scene == .pairing ? .unpaired(nil) : .active, host: "himawari.example.com", kind: .mac)
        let messagesOn = scene == .settingsMessagesOn || scene == .settingsMessagesNoAccess
        let store = MacSettingsStore(demo: settings(seesMessages: messagesOn), messagesReadable: scene != .settingsMessagesNoAccess)
        let shortcut: GlobalShortcut.State = scene == .settingsShortcutTaken ? .taken(.optionSpace) : .active(.optionSpace)
        let menu = MenuBarModel(
            demo: app,
            settings: store,
            home: scene == .panelQuiet ? nil : home(),
            running: [RunningWork(id: "w", title: "整理“下载”文件夹", progress: DeviceProgress(done: 21, total: 38), progressLabel: "已移动 21 / 38")],
            shortcut: shortcut,
            notices: scene == .panelNotice || scene == .panelNoticesOpen ? notices : [],
            noticesExpanded: scene == .panelNoticesOpen
        )
        let input = InputBarModel(api: app.api, chat: { nil }, limits: { nil })
        switch scene {
        case .inputBar, .inputBarAnswer:
            input.begin(with: ContextSnapshot(frontApp: FrontApp(name: "Xcode", bundleId: "com.apple.dt.Xcode"), selection: "let request = try? await signer.sign(code)\nlet reply = await transport.send(request!)\nif reply.expired { state = .expired }\ntimer.invalidate()"), seesFrontmost: true)
            input.draft = "这段为什么配对超时后会崩"
            if scene == .inputBarAnswer {
                input.preview(threadId: "demo", answer: answerSentence)
            }
            return AnyView(InputBarView(model: input, shortcutLabel: menu.activeShortcutLabel, submit: {}))
        case .dropFile:
            let file = FileManager.default.temporaryDirectory.appendingPathComponent("报价单 11 月.xlsx")
            try? Data([0x50, 0x4b, 0x03, 0x04]).write(to: file)
            input.begin(with: ContextSnapshot(), seesFrontmost: true)
            input.add(pieces: [ContextGathering.filePiece(file, source: .droppedFile, reading: ContextReader.read(file))])
            input.draft = "和上个月的差在哪"
            return AnyView(InputBarView(model: input, shortcutLabel: nil, submit: {}))
        case .checklist, .checklistOpen:
            return AnyView(ChecklistView(list: checklist, expanded: scene == .checklistOpen, decline: {}, approve: {}))
        case .panel, .panelQuiet, .panelNotice, .panelNoticesOpen:
            return AnyView(PanelView(model: menu, talk: {}, pair: {}))
        case .settings, .settingsShortcutTaken, .settingsMessagesOn, .settingsMessagesNoAccess:
            return AnyView(MacSettingsView(store: store, shortcutState: shortcut, scrolls: false))
        case .pairing:
            return AnyView(MacPairingView(model: app, inbox: PairingInbox()))
        }
    }

    static func record(into folder: URL) {
        SerifFace.shared.prepare()
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        for (appearance, suffix) in [(NSAppearance.Name.aqua, "light"), (.darkAqua, "dark")] {
            NSApp.appearance = NSAppearance(named: appearance)
            for scene in MacDemoScene.allCases {
                let host = NSHostingView(rootView: view(for: scene)
                    .padding(DesignTokens.Mac.panelPadding * 2)
                    .background(Color.hmGlow))
                let size = host.fittingSize
                let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
                window.appearance = NSAppearance(named: appearance)
                window.contentView = host
                host.layoutSubtreeIfNeeded()
                window.makeFirstResponder(nil)
                RunLoop.main.run(until: Date().addingTimeInterval(0.4))
                guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { continue }
                host.cacheDisplay(in: host.bounds, to: bitmap)
                try? bitmap.representation(using: .png, properties: [:])?.write(to: folder.appendingPathComponent("\(scene.rawValue)-\(suffix).png"))
            }
        }
    }
}
#endif
