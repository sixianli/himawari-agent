import Foundation
import XCTest

@MainActor
final class EndToEndTests: XCTestCase {
    private var backend: EndToEndBackend!
    private var answers: EndToEndBackend.Answers!
    private var app: XCUIApplication!

    override func setUp() async throws {
        continueAfterFailure = false
        backend = try EndToEndBackend.fromEnvironment()
        answers = try await backend.answers()
        try await backend.goOnline()
        addUIInterruptionMonitor(withDescription: "system permission alert") { alert in
            guard let allow = alert.buttons.allElementsBoundByIndex.last else { return false }
            allow.tap()
            return true
        }
        app = XCUIApplication.himawari()
        app.launch()
        try await pairIfNeeded()
        SystemAlerts.allow(within: 5)
    }

    override func tearDown() async throws {
        if let app, app.state != .notRunning {
            attachScreenshot("\(name) end", app: app)
        }
        try? await backend?.goOnline()
    }

    func testSendingShowsTheAnswerWhileItIsStillArriving() async throws {
        let text = "stream \(UUID().uuidString.prefix(6))"
        send(text)
        let opening = "\(answers.opening)“\(text)”"
        var partial: String?
        var finished = false
        let deadline = Date().addingTimeInterval(60)
        while Date() < deadline {
            let answer = app.texts(containing: opening).firstMatch
            if answer.exists {
                let shown = [answer.label, answer.value as? String ?? ""].joined()
                if shown.contains(answers.ending) {
                    finished = true
                    break
                }
                partial = partial ?? shown
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTAssertTrue(finished, "the answer to \"\(text)\" never finished on screen")
        XCTAssertNotNil(partial, "the answer only appeared once it was complete: the phone did not show it while it was streaming")
    }

    func testTappingSendTwiceQuicklySendsTheMessageOnce() async throws {
        let text = "twice \(UUID().uuidString.prefix(6))"
        let composer = app.composer
        composer.tap()
        composer.typeText(text)
        XCTAssertTrue(app.waitFor(5) { app.sendButton.exists }, "no send button after typing")
        app.sendButton.doubleTap()
        XCTAssertTrue(
            app.waitFor(60) { app.texts(containing: "\(answers.opening)“\(text)”").firstMatch.exists },
            "no answer for \"\(text)\""
        )
        let sent = try await waitForStored(text)
        XCTAssertEqual(sent, 1, "the server stored \"\(text)\" \(sent) times after a double tap on send")
        try await Task.sleep(for: .seconds(2))
        let bubbles = app.staticTexts.matching(NSPredicate(format: "label == %@", text)).count
        XCTAssertEqual(bubbles, 1, "the chat shows \"\(text)\" \(bubbles) times after a double tap on send")
    }

    func testStaysConnectedWhileIdle() async throws {
        let offline = [AppStrings.text("chat.offline"), AppStrings.text("main.retry"), AppStrings.text("chat.queued.offline")]
        let shownOffline = app.waitFor(20, poll: 0.5) {
            offline.contains { app.texts(containing: $0).firstMatch.exists } || app.composer.placeholderValue == offline[0]
        }
        XCTAssertFalse(shownOffline, "the chat said it was not connected while the server was up and nothing was happening")
    }

    func testAMessageWrittenOfflineIsSentOnceTheServerIsBack() async throws {
        try await backend.goOffline()
        let placeholder = AppStrings.text("chat.offline")
        XCTAssertTrue(
            app.waitFor(30) { app.composer.placeholderValue == placeholder },
            "the chat did not say it was offline after the server went away"
        )
        let text = "offline \(UUID().uuidString.prefix(6))"
        send(text)
        try await backend.goOnline()
        XCTAssertTrue(
            app.waitFor(90) { app.texts(containing: "\(answers.opening)“\(text)”").firstMatch.exists },
            "the message written offline was not answered after the server came back"
        )
        XCTAssertTrue(
            app.waitFor(15) { app.composer.placeholderValue == AppStrings.text("chat.input.placeholder") },
            "the chat still says it is offline after the server came back"
        )
        let sent = try await waitForStored(text)
        XCTAssertEqual(sent, 1, "the server stored the offline message \(sent) times")
    }

    func testLongPressOnAMessageOpensItsMenu() async throws {
        let text = "menu \(UUID().uuidString.prefix(6))"
        send(text)
        XCTAssertTrue(
            app.waitFor(60) { answerFinished(to: text) },
            "no finished answer for \"\(text)\""
        )
        if app.keyboards.firstMatch.exists {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.3)).tap()
        }
        if !app.waitFor(3, { !app.keyboards.firstMatch.exists }) {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4))
                .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.97)))
        }
        XCTAssertTrue(app.waitFor(5) { !app.keyboards.firstMatch.exists }, "the keyboard did not go away")
        let bubble = app.staticTexts.matching(NSPredicate(format: "label == %@", text)).firstMatch
        _ = app.waitFor(10) {
            if bubble.exists && bubble.isHittable { return true }
            app.swipeUp(velocity: .slow)
            return false
        }
        var lastFrame = CGRect.null
        let settled = app.waitFor(15, poll: 0.5) {
            guard bubble.exists, bubble.isHittable else { return false }
            let frame = bubble.frame
            defer { lastFrame = frame }
            return frame == lastFrame
        }
        XCTAssertTrue(settled, "the sent message did not stay still on screen long enough to press")
        bubble.press(forDuration: 1.0)
        let copy = app.buttons[AppStrings.text("chat.menu.copy")]
        XCTAssertTrue(copy.waitForExistence(timeout: 5), "long press did not open the message menu")
        attachScreenshot("message menu", app: app)
        XCTAssertTrue(app.buttons[AppStrings.text("chat.menu.reply")].exists)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap()
        XCTAssertTrue(app.waitFor(5) { !copy.exists }, "the message menu did not close")
    }

    func testALongConversationScrollsToItsStartAndBack() async throws {
        let first = "scroll start \(UUID().uuidString.prefix(6))"
        send(first)
        XCTAssertTrue(app.waitFor(60) { app.texts(containing: "\(answers.opening)“\(first)”").firstMatch.exists })
        let long = "\(answers.longRequest) \(UUID().uuidString.prefix(6))"
        send(long)
        XCTAssertTrue(app.waitFor(120) { answerFinished(to: long) }, "the long answer did not finish")
        let start = app.staticTexts.matching(NSPredicate(format: "label == %@", first)).firstMatch
        let reachedStart = app.waitFor(30, poll: 0.1) {
            if start.exists && start.isHittable { return true }
            app.swipeDown(velocity: .fast)
            return false
        }
        XCTAssertTrue(reachedStart, "could not scroll back to the start of the conversation")
        XCTAssertTrue(app.composer.isHittable, "the input box is not usable after scrolling")
    }

    func testEveryRowOnHerPageOpensAndSwipesBack() async throws {
        let herPage = AppStrings.text("chat.herPage")
        app.buttons[herPage].firstMatch.tap()
        let title = app.navigationBars[herPage]
        XCTAssertTrue(title.waitForExistence(timeout: 10), "her page did not open")
        try await Task.sleep(for: .seconds(2))
        let list = app.herPageList
        XCTAssertTrue(list.waitForExistence(timeout: 10), "her page has no memory row")
        let rows = list.buttons.allElementsBoundByIndex
            .filter { $0.isHittable }
            .map(\.label)
        XCTAssertFalse(rows.isEmpty, "her page has no rows")
        for row in rows {
            let button = list.buttons[row].firstMatch
            guard button.exists else { continue }
            button.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
            let pushed = app.waitFor(5) { !title.exists || !title.isHittable }
            XCTAssertTrue(pushed, "tapping the right side of \"\(row)\" on her page did nothing")
            guard pushed else { continue }
            attachScreenshot("her page / \(row)", app: app)
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5))
                .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.5)))
            if !app.waitFor(3, { title.exists && title.isHittable }) {
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12))
                    .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)))
            }
            let close = app.buttons[AppStrings.manage("close")].firstMatch
            if !app.waitFor(3, { title.exists && title.isHittable }), close.exists {
                close.tap()
            }
            XCTAssertTrue(
                app.waitFor(5) { title.exists && title.isHittable },
                "swiping back from \"\(row)\" did not return to her page"
            )
        }
    }

    func testMemorySearchFieldTakesTyping() async throws {
        let herPage = AppStrings.text("chat.herPage")
        app.buttons[herPage].firstMatch.tap()
        XCTAssertTrue(app.navigationBars[herPage].waitForExistence(timeout: 10))
        let memory = app.herPageList.buttons.matching(
            NSPredicate(format: "label BEGINSWITH %@", AppStrings.manage("herMemory"))
        ).firstMatch
        XCTAssertTrue(memory.waitForExistence(timeout: 10), "her page has no memory row")
        memory.tap()
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 10), "the memory page has no search field")
        search.tap()
        search.typeText("e2e")
        XCTAssertTrue(
            app.waitFor(5) { (search.value as? String)?.contains("e2e") == true },
            "the memory search field did not take typing"
        )
    }

    private func answerFinished(to text: String) -> Bool {
        if app.texts(containing: "\(answers.ending)（\(text)）").firstMatch.exists { return true }
        let answer = app.texts(containing: "\(answers.opening)“\(text)”").firstMatch
        return answer.exists && [answer.label, answer.value as? String ?? ""].joined().contains(answers.ending)
    }

    private func send(_ text: String) {
        let composer = app.composer
        XCTAssertTrue(composer.waitForExistence(timeout: 20), "no chat input box")
        composer.tap()
        composer.typeText(text)
        XCTAssertTrue(app.waitFor(5) { app.sendButton.exists }, "no send button after typing")
        app.sendButton.tap()
    }

    private func waitForStored(_ text: String) async throws -> Int {
        var count = 0
        for _ in 0..<20 {
            count = try await backend.messages().filter { $0.role != "agent" && $0.text.contains(text) }.count
            if count > 0 { break }
            try await Task.sleep(for: .milliseconds(500))
        }
        return count
    }

    private func pairIfNeeded() async throws {
        if app.composer.waitForExistence(timeout: 8) { return }
        let link = try await backend.pairingLink()
        app.open(link)
        let connect = app.buttons[AppStrings.text("pairing.connect")]
        XCTAssertTrue(connect.waitForExistence(timeout: 20), "opening the pairing link did not ask to connect")
        connect.tap()
        XCTAssertTrue(app.composer.waitForExistence(timeout: 60), "pairing did not reach the chat")
    }
}
