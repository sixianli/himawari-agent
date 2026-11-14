import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import HimawariCore

@Suite struct AttachmentFormatTests {
    struct Vector: Decodable {
        let text: String
        let files: [MessageAttachment]
        let joined: String
    }

    struct Vectors: Decodable { let vectors: [Vector] }

    @Test func composesExactlyWhatTheWebComposerProduces() throws {
        let url = try #require(Bundle.module.url(forResource: "attachment-vectors", withExtension: "json", subdirectory: "Fixtures"))
        let vectors = try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url)).vectors
        #expect(vectors.count == 3)
        for vector in vectors {
            #expect(MessageAttachments.compose(text: vector.text, attachments: vector.files) == vector.joined)
        }
    }

    @Test func namesLoseCharactersThatWouldBreakTheTag() {
        #expect(MessageAttachments.cleanName("a\"b<c>d\ne.txt") == "abcde.txt")
        #expect(MessageAttachments.cleanName("  \n ") == "file")
    }

    let limits = AttachmentLimits(textCharacters: 256 * 1024, imageCharacters: 1_048_576 - 1024, perMessage: 10, messageCharacters: 65536)

    @Test func clipsContentAtTheServerCharacterLimitWithoutSplittingAnEmoji() {
        let long = String(repeating: "葵", count: 7) + "😀"
        let clipped = MessageAttachments.clip(long, characters: 8)
        #expect(clipped.truncated)
        #expect(clipped.text == String(repeating: "葵", count: 7))
        #expect(MessageAttachments.clip(long, characters: 9) == (long, false))
        #expect(MessageAttachments.clip("短", characters: 1).truncated == false)
    }

    @Test func refusesMoreThanTheServersAttachmentCount() {
        let one = MessageAttachment(name: "a", ref: "r", bytes: 1, kind: .text, truncated: false)
        #expect(MessageAttachments.fits(text: "x", attachments: Array(repeating: one, count: 10), limits: limits))
        #expect(!MessageAttachments.fits(text: "x", attachments: Array(repeating: one, count: 11), limits: limits))
        let three = AttachmentLimits(textCharacters: 10, imageCharacters: 10, perMessage: 3, messageCharacters: 65536)
        #expect(!MessageAttachments.fits(text: "x", attachments: Array(repeating: one, count: 4), limits: three))
        let short = AttachmentLimits(textCharacters: 10, imageCharacters: 10, perMessage: 3, messageCharacters: 60)
        #expect(MessageAttachments.fits(text: "x", attachments: [one], limits: short))
        #expect(!MessageAttachments.fits(text: String(repeating: "x", count: 20), attachments: [one], limits: short))
    }

    @Test func theConfigCarriesTheAttachmentLimitsAndAnOlderServerHasNone() throws {
        let base = #""heartbeatSeconds":30,"connectionMaxSeconds":600,"signatureToleranceSeconds":300,"limits":[]"#
        let newer = try JSONDecoder().decode(DeviceConfiguration.self, from: Data(("{" + base + #","attachments":{"textCharacters":262144,"imageCharacters":1047552,"perMessage":10,"messageCharacters":65536}}"#).utf8))
        #expect(newer.attachments == limits)
        let older = try JSONDecoder().decode(DeviceConfiguration.self, from: Data(("{" + base + "}").utf8))
        #expect(older.attachments == nil)
    }
}

@Suite struct ContextGatheringTests {
    let labels = ContextLabels(frontApp: { "正在用：\($0.name)" }, selection: { "选中的 \($0) 行" })

    @Test func carriesAppDocumentAndSelectionWhenTheOwnerAllowsSeeingTheFrontApp() throws {
        let folder = try TemporaryFolder()
        let file = folder.url.appendingPathComponent("PairingView.swift")
        try "func confirm() {}".write(to: file, atomically: true, encoding: .utf8)
        let snapshot = ContextSnapshot(frontApp: FrontApp(name: "Xcode", bundleId: "com.apple.dt.Xcode"), document: file, selection: "a\nb\nc\nd")
        let pieces = ContextGathering.pieces(from: snapshot, seesFrontmost: true, labels: labels, readFile: PlainTextFile.read)
        #expect(pieces.map(\.source) == [.frontApp, .document, .selection])
        #expect(pieces[0].name == "正在用：Xcode")
        #expect(pieces[0].content == "Xcode (com.apple.dt.Xcode)")
        #expect(pieces[1].name == "PairingView.swift")
        #expect(pieces[1].content == "func confirm() {}")
        #expect(pieces[2].name == "选中的 4 行")
    }

    @Test func leavesOutAppAndDocumentWhenSeeingTheFrontAppIsOff() {
        let snapshot = ContextSnapshot(frontApp: FrontApp(name: "Xcode", bundleId: nil), document: URL(fileURLWithPath: "/tmp/x.swift"), selection: "only this")
        let pieces = ContextGathering.pieces(from: snapshot, seesFrontmost: false, labels: labels, readFile: PlainTextFile.read)
        #expect(pieces.map(\.source) == [.selection])
    }

    @Test func blankSelectionCarriesNothing() {
        let pieces = ContextGathering.pieces(from: ContextSnapshot(selection: " \n "), seesFrontmost: true, labels: labels, readFile: PlainTextFile.read)
        #expect(pieces.isEmpty)
    }

    @Test func aFileWithoutTextKeepsItsNameAndSendsOnlyItsPath() throws {
        let folder = try TemporaryFolder()
        let file = folder.url.appendingPathComponent("报价单 11 月.xlsx")
        try Data([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]).write(to: file)
        let piece = ContextGathering.filePiece(file, source: .droppedFile, reading: PlainTextFile.read(file))
        #expect(piece.name == "报价单 11 月.xlsx")
        #expect(piece.content == file.path)
        #expect(piece.bytes == 6)
    }

    @Test func droppingMoreFilesThanAMessageCanCarryKeepsTheFirstOnesAndSaysSo() {
        let files = (0 ..< 5).map { ContextPiece(source: .droppedFile, name: "\($0).txt", content: "x", fileURL: URL(fileURLWithPath: "/tmp/\($0).txt")) }
        let merged = ContextGathering.merge(Array(files.prefix(1)), adding: Array(files.dropFirst()), limit: 3)
        #expect(merged.pieces.map(\.name) == ["0.txt", "1.txt", "2.txt"])
        #expect(merged.overflowed)
        let fits = ContextGathering.merge([], adding: Array(files.prefix(3)), limit: 3)
        #expect(fits.pieces.count == 3 && !fits.overflowed)
        #expect(ContextGathering.merge([], adding: files, limit: nil).pieces.count == 5)
    }

    @Test func droppingTheSameFileTwiceKeepsOneChip() {
        let url = URL(fileURLWithPath: "/tmp/a.txt")
        let a = ContextPiece(source: .droppedFile, name: "a.txt", content: "x", fileURL: url)
        let b = ContextPiece(source: .droppedFile, name: "a.txt", content: "x", fileURL: url)
        #expect(ContextGathering.merge([a], adding: [b]).count == 1)
    }
}

@Suite struct PathPolicyTests {
    @Test func allowsReadingInsideAGrantedFolderAndRefusesWritingInAReadOnlyOne() throws {
        let root = try TemporaryFolder()
        let downloads = root.url.appendingPathComponent("Downloads")
        let work = root.url.appendingPathComponent("Work")
        try FileManager.default.createDirectory(at: downloads, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        let grants = [FolderGrant(id: "d", path: downloads.path, access: .readWrite), FolderGrant(id: "w", path: work.path, access: .read)]
        #expect(PathPolicy.decide(downloads.appendingPathComponent("a.pdf").path, use: .write, grants: grants) == .allowed(grantId: "d", realPath: PathPolicy.realPath(downloads.path) + "/a.pdf"))
        #expect(PathPolicy.decide(work.appendingPathComponent("b.txt").path, use: .read, grants: grants) == .allowed(grantId: "w", realPath: PathPolicy.realPath(work.path) + "/b.txt"))
        #expect(PathPolicy.decide(work.appendingPathComponent("b.txt").path, use: .write, grants: grants) == .readOnly(grantId: "w", realPath: PathPolicy.realPath(work.path) + "/b.txt"))
    }

    @Test func dotDotCannotClimbOutOfAGrantedFolder() throws {
        let root = try TemporaryFolder()
        let downloads = root.url.appendingPathComponent("Downloads")
        try FileManager.default.createDirectory(at: downloads, withIntermediateDirectories: true)
        let grants = [FolderGrant(id: "d", path: downloads.path, access: .readWrite)]
        let escape = downloads.path + "/../secret.txt"
        #expect(PathPolicy.decide(escape, use: .read, grants: grants) == .outsideAllowedFolders(realPath: PathPolicy.realPath(root.url.path) + "/secret.txt"))
    }

    @Test func aSymlinkInsideAGrantedFolderPointingOutsideIsRefused() throws {
        let root = try TemporaryFolder()
        let downloads = root.url.appendingPathComponent("Downloads")
        let private_ = root.url.appendingPathComponent("Private")
        try FileManager.default.createDirectory(at: downloads, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: private_, withIntermediateDirectories: true)
        try "secret".write(to: private_.appendingPathComponent("keys.txt"), atomically: true, encoding: .utf8)
        try FileManager.default.createSymbolicLink(at: downloads.appendingPathComponent("link"), withDestinationURL: private_)
        let grants = [FolderGrant(id: "d", path: downloads.path, access: .readWrite)]
        let decision = PathPolicy.decide(downloads.path + "/link/keys.txt", use: .read, grants: grants)
        #expect(decision == .outsideAllowedFolders(realPath: PathPolicy.realPath(private_.path) + "/keys.txt"))
    }

    @Test func dotDotAfterASymlinkClimbsFromWhereTheLinkPointsNotFromTheGrantedFolder() throws {
        let root = try TemporaryFolder()
        let downloads = root.url.appendingPathComponent("Downloads")
        let outside = root.url.appendingPathComponent("Outside/dir")
        try FileManager.default.createDirectory(at: downloads, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        try "secret".write(to: root.url.appendingPathComponent("Outside/secret.txt"), atomically: true, encoding: .utf8)
        try "mine".write(to: downloads.appendingPathComponent("secret.txt"), atomically: true, encoding: .utf8)
        try FileManager.default.createSymbolicLink(at: downloads.appendingPathComponent("link"), withDestinationURL: outside)
        let grants = [FolderGrant(id: "d", path: downloads.path, access: .readWrite)]
        let decision = PathPolicy.decide(downloads.path + "/link/../secret.txt", use: .read, grants: grants)
        #expect(decision == .outsideAllowedFolders(realPath: PathPolicy.realPath(root.url.path) + "/Outside/secret.txt"))
        #expect(PathPolicy.decide(downloads.path + "/link/../new.txt", use: .write, grants: grants) == .outsideAllowedFolders(realPath: PathPolicy.realPath(root.url.path) + "/Outside/new.txt"))
    }

    @Test func aFolderWhoseNameStartsLikeAGrantedOneIsNotInsideIt() throws {
        let root = try TemporaryFolder()
        let docs = root.url.appendingPathComponent("Docs")
        let docsOld = root.url.appendingPathComponent("Docs-old")
        try FileManager.default.createDirectory(at: docs, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: docsOld, withIntermediateDirectories: true)
        let grants = [FolderGrant(id: "d", path: docs.path, access: .read)]
        if case .outsideAllowedFolders = PathPolicy.decide(docsOld.path + "/x.txt", use: .read, grants: grants) {} else {
            Issue.record("Docs-old must not count as inside Docs")
        }
    }

    @Test func theNearestGrantWins() throws {
        let root = try TemporaryFolder()
        let inner = root.url.appendingPathComponent("Docs/Work")
        try FileManager.default.createDirectory(at: inner, withIntermediateDirectories: true)
        let grants = [FolderGrant(id: "outer", path: root.url.appendingPathComponent("Docs").path, access: .readWrite), FolderGrant(id: "inner", path: inner.path, access: .read)]
        if case let .readOnly(grantId, _) = PathPolicy.decide(inner.path + "/a.txt", use: .write, grants: grants) {
            #expect(grantId == "inner")
        } else {
            Issue.record("the read-only inner grant must decide")
        }
    }

    @Test func aGrantReachedThroughALinkedParentStillCoversFilesThatDoNotExistYet() throws {
        let root = try TemporaryFolder()
        let real = root.url.appendingPathComponent("private/var/Downloads")
        try FileManager.default.createDirectory(at: real, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: root.url.appendingPathComponent("var"), withDestinationURL: root.url.appendingPathComponent("private/var"))
        let linked = root.url.appendingPathComponent("var/Downloads").path
        let grants = [FolderGrant(id: "d", path: linked, access: .readWrite)]
        #expect(PathPolicy.decide(linked + "/new.pdf", use: .write, grants: grants) == .allowed(grantId: "d", realPath: PathPolicy.realPath(real.path) + "/new.pdf"))
        #expect(PathPolicy.contains("/private/var/Downloads", "/private/var/Downloads/new.pdf"))
        #expect(!PathPolicy.contains("/private/var/Downloads", "/var/Downloads/new.pdf"))
    }

    @Test func relativePathsAreRefused() {
        #expect(PathPolicy.decide("Downloads/a.txt", use: .read, grants: []) == .notAbsolute)
    }

    @Test func addingTheSameFolderTwiceKeepsOneGrantWithTheNewAccess() throws {
        let root = try TemporaryFolder()
        var settings = MacAccessSettings()
        settings.add(FolderGrant(path: root.url.path, access: .read))
        settings.add(FolderGrant(path: root.url.path + "/.", access: .readWrite))
        #expect(settings.folders.count == 1)
        #expect(settings.folders[0].access == .readWrite)
    }
}

@Suite struct URLPolicyTests {
    let hosts = ["example.com"]

    @Test func onlyHTTPSOnAllowedHostsOpens() {
        #expect(URLPolicy.decide("https://example.com/a", allowedHosts: hosts) == .allowed(URL(string: "https://example.com/a")!))
        #expect(URLPolicy.decide("https://docs.example.com/a", allowedHosts: hosts) == .allowed(URL(string: "https://docs.example.com/a")!))
        #expect(URLPolicy.decide("https://badexample.com/a", allowedHosts: hosts) == .hostNotAllowed("badexample.com"))
    }

    @Test func otherSchemesAreRefused() {
        #expect(URLPolicy.decide("http://example.com", allowedHosts: hosts) == .notHTTPS)
        #expect(URLPolicy.decide("file:///etc/passwd", allowedHosts: hosts) == .notHTTPS)
        #expect(URLPolicy.decide("javascript:alert(1)", allowedHosts: hosts) == .notHTTPS)
        #expect(URLPolicy.decide("x-himawari://run", allowedHosts: hosts) == .notHTTPS)
        #expect(URLPolicy.decide("https://user:pw@example.com", allowedHosts: hosts) == .invalid)
    }
}

@Suite struct MenuBarFeedTests {
    @Test func mostPressingIsTheFirstItemWaitingForTheOwnerWithTwoButtons() throws {
        let json = """
        {"items":[
          {"key":"done:1","kind":"done","awaitsOwner":false,"sentence":"整理好了","actions":[]},
          {"key":"approval:9","kind":"some_future_kind","awaitsOwner":true,"sentence":"田中把周五的会改到 15:00，出门提醒要跟着改吗","actions":[
            {"action":"approved","label":"改到 9:40","polarity":"positive","ownerPresence":false,"binding":"b1"},
            {"action":"denied","label":"不用","polarity":"negative","ownerPresence":false,"binding":"b2"},
            {"action":"snooze","label":"稍后","polarity":"neutral","ownerPresence":false,"binding":"b3"}]},
          {"key":"approval:10","kind":"approval","awaitsOwner":true,"sentence":"第二件","actions":[]}],
         "awaitingCount":2,"revision":"r1"}
        """
        let snapshot = try JSONDecoder().decode(HomeSnapshot.self, from: Data(json.utf8))
        let item = try #require(snapshot.mostPressing)
        #expect(item.key == "approval:9")
        #expect(item.shownActions.map(\.label) == ["改到 9:40", "不用"])
        #expect(snapshot.awaitingCount == 2)
    }

    @Test func anActionWithoutABindingIsNeverAMenuBarButton() {
        let item = HomeItem(key: "connection:gmail", kind: "connection", awaitsOwner: true, sentence: "要重新连接", actions: [
            HomeAction(action: "reconnect", label: "重连", polarity: "positive", ownerPresence: false, binding: nil),
            HomeAction(action: "dismiss", label: "知道了", polarity: "neutral", ownerPresence: false, binding: "b1"),
        ])
        #expect(item.shownActions.map(\.label) == ["知道了"])
    }

    @Test func nothingWaitingMeansNoCard() throws {
        let json = #"{"items":[{"key":"done:1","kind":"done","awaitsOwner":false,"sentence":"x","actions":[]}],"awaitingCount":0,"revision":"r"}"#
        #expect(try JSONDecoder().decode(HomeSnapshot.self, from: Data(json.utf8)).mostPressing == nil)
    }

    @Test func detailFollowsTheOwnersLanguage() {
        let detail = ["zh-CN": "移动 38 个、改名 6 个", "en": "Move 38, rename 6", "ja": "38 件移動、6 件名前変更"]
        #expect(DetailLocale.pick(detail, preferred: ["ja-JP"]) == "38 件移動、6 件名前変更")
        #expect(DetailLocale.pick(detail, preferred: ["zh-Hans-CN"]) == "移动 38 个、改名 6 个")
        #expect(DetailLocale.pick(detail, preferred: ["fr-FR"]) == "移动 38 个、改名 6 个")
    }

    @Test func progressStaysInsideItsTotal() {
        #expect(DeviceProgress(done: 21, total: 38).fraction > 0.55)
        #expect(DeviceProgress(done: 50, total: 38).done == 38)
    }
}

@Suite struct AttachmentUploadTests {
    @Test func uploadsEachPieceAndBuildsTagsFromTheReturnedRefs() async throws {
        let exchange = RecordingExchange([
            HTTPExchangeResponse(status: 200, body: Data(#"{"ref":"pay_a"}"#.utf8)),
            HTTPExchangeResponse(status: 200, body: Data(#"{"ref":"pay_b"}"#.utf8)),
        ])
        let http = try uploadClient(exchange)
        let api = DeviceAPI(http: http)
        let pieces = [
            ContextPiece(source: .frontApp, name: "正在用：Xcode", content: "Xcode"),
            ContextPiece(source: .selection, name: "选中的 1 行", content: "let a = 1"),
        ]
        let requestId = OutgoingMessage.newId()
        let attachments = try await api.attach(pieces, requestId: requestId, limits: AttachmentLimits(textCharacters: 4, imageCharacters: 4, perMessage: 10, messageCharacters: 65536))
        #expect(attachments.map(\.ref) == ["pay_a", "pay_b"])
        #expect(exchange.requests.count == 2)
        #expect(exchange.requests.allSatisfy { $0.url?.path == "/api/device/v1/attachments" && $0.httpMethod == "POST" })
        let first = try JSONSerialization.jsonObject(with: try #require(exchange.requests[0].httpBody)) as? [String: String]
        #expect(first == ["requestId": "\(requestId)-0", "content": "Xcod", "as": "text"])
        let messageIdPattern = #"^[A-Za-z0-9_-]{16,64}$"#
        #expect(first?["requestId"]?.range(of: messageIdPattern, options: .regularExpression) != nil)
        #expect(MessageAttachments.compose(text: "为什么", attachments: attachments) == "为什么\n\n<file name=\"正在用：Xcode\" ref=\"pay_a\" bytes=\"5\" kind=\"text\" truncated=\"1\"/>\n\n<file name=\"选中的 1 行\" ref=\"pay_b\" bytes=\"9\" kind=\"text\" truncated=\"1\"/>")
    }

    @Test func aRefThatWouldBreakTheTagIsRefused() async throws {
        let exchange = RecordingExchange([HTTPExchangeResponse(status: 200, body: Data(#"{"ref":"a\" kind=\"image"}"#.utf8))])
        let http = try uploadClient(exchange)
        await #expect(throws: DeviceAPIError.invalidResponse) {
            _ = try await DeviceAPI(http: http).uploadAttachment(requestId: "r", content: "x", as: .text)
        }
    }
}

func uploadClient(_ exchange: RecordingExchange) throws -> DeviceHTTPClient {
    let http = DeviceHTTPClient(exchange: exchange, now: { Date(timeIntervalSince1970: 1_800_000_000) })
    http.use(DeviceCredentials(origin: try #require(URL(string: "https://himawari.example.test/")), deviceId: "dev_AAAAAAAAAAAAAAAAAAAAAA", access: nil, deviceKey: try SoftwareKeySigner()))
    return http
}

struct TemporaryFolder {
    let url: URL

    init() throws {
        url = FileManager.default.temporaryDirectory.appendingPathComponent("himawari-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }
}

@Suite struct MacSettingsTests {
    @Test func defaultsCallItWithOptionSpaceAndSeeTheFrontAppButNotMessages() {
        let settings = MacAccessSettings()
        #expect(settings.shortcut == .optionSpace)
        #expect(settings.shortcut.modifierSymbols == "⌥")
        #expect(settings.seesFrontmost)
        #expect(!settings.seesMessages)
    }

    @Test func aShortcutWithoutOptionCommandOrControlIsRefused() {
        #expect(!KeyShortcut(keyCode: 49, modifiers: KeyShortcut.shiftModifier, key: "space").hasModifier)
        #expect(KeyShortcut(keyCode: 49, modifiers: KeyShortcut.commandModifier | KeyShortcut.shiftModifier, key: "space").modifierSymbols == "⇧⌘")
    }

    @Test func survivesSavingAndLoading() throws {
        var settings = MacAccessSettings()
        settings.add(FolderGrant(id: "a", path: "/Users/andy/Downloads", access: .readWrite))
        settings.add(AppGrant(bundleId: "com.apple.finder", name: "访达"))
        settings.seesMessages = true
        let loaded = try JSONDecoder().decode(MacAccessSettings.self, from: JSONEncoder().encode(settings))
        #expect(loaded == settings)
        #expect(loaded.allowsApp("com.apple.finder"))
        #expect(!loaded.allowsApp("com.apple.Terminal"))
    }
}
