import XCTest

@MainActor
final class SignInTests: XCTestCase {
    override func setUp() async throws {
        continueAfterFailure = true
    }

    func testTheWelcomePageOpensTheSetupCodePageAndTheServerSheetAndComesBack() throws {
        let app = DemoApp.launch("11-sign-in")
        let passkey = app.buttons["用通行密钥登录"].firstMatch
        XCTAssertTrue(passkey.waitForExistence(timeout: 10), "the welcome page has no passkey button")
        XCTAssertTrue(passkey.isEnabled, "the passkey button is grey although a server is set")
        let firstTime = app.buttons["第一次用？输入设置码"].firstMatch
        XCTAssertTrue(firstTime.isHittable, "the setup code button cannot be tapped")
        firstTime.tap()
        let codeTitle = app.navigationBars["输入设置码"].firstMatch
        XCTAssertTrue(codeTitle.waitForExistence(timeout: 5), "tapping the setup code button opened nothing")
        codeTitle.buttons.firstMatch.tap()
        XCTAssertTrue(DemoApp.waitUntil(timeout: 5) { firstTime.isHittable }, "the back button did not return to the welcome page")
        let server = app.buttons["服务器"].firstMatch
        XCTAssertTrue(server.isHittable, "the server button cannot be tapped")
        server.tap()
        let sheet = app.navigationBars["服务器"].firstMatch
        XCTAssertTrue(sheet.waitForExistence(timeout: 5), "tapping the server button opened no sheet")
        sheet.buttons["取消"].firstMatch.tap()
        XCTAssertTrue(DemoApp.waitUntil(timeout: 5) { firstTime.isHittable }, "cancel did not close the server sheet")
    }

    func testTheSetupCodePageWaitsForACodeBeforeItCanContinue() throws {
        let app = DemoApp.launch("15-sign-in-1-code")
        let field = app.textFields["输入设置码"].firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10), "the setup code page has no code field")
        let next = app.navigationBars["输入设置码"].buttons["继续"].firstMatch
        XCTAssertTrue(next.exists, "the setup code page has no continue button")
        XCTAssertFalse(next.isEnabled, "continue can be tapped with no code typed")
    }

    func testAWrongOrExpiredCodeSaysSoAndTypingAgainClearsTheMessage() throws {
        for (scene, message) in [("15-sign-in-2-code-invalid", "设置码不对，请检查一下。"), ("15-sign-in-3-code-expired", "这个设置码已经失效，请重新生成一个。")] {
            let app = DemoApp.launch(scene)
            let text = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", message)).firstMatch
            XCTAssertTrue(text.waitForExistence(timeout: 10), "\(scene): the page does not say \(message)")
            let field = app.textFields["输入设置码"].firstMatch
            field.tap()
            field.typeText("A")
            XCTAssertTrue(DemoApp.waitUntil(timeout: 5) { !text.exists }, "\(scene): the message stayed after typing again")
            app.terminate()
        }
    }

    func testTheServerSheetClosesWithCancel() throws {
        let app = DemoApp.launch("15-sign-in-4-server")
        let sheet = app.navigationBars["服务器"].firstMatch
        XCTAssertTrue(sheet.waitForExistence(timeout: 10), "the server sheet is not open")
        XCTAssertTrue(app.textFields["服务器"].firstMatch.exists, "the server sheet has no address field")
        sheet.buttons["取消"].firstMatch.tap()
        XCTAssertTrue(DemoApp.waitUntil(timeout: 5) { app.buttons["用通行密钥登录"].firstMatch.isHittable }, "cancel did not return to the welcome page")
    }

    func testTheWelcomePageExplainsAMissingPasskeyAndARemovedDevice() throws {
        for (scene, message) in [("15-sign-in-5-no-passkey", "这台设备上还没有 Himawari 的通行密钥。第一次用请输入设置码。"), ("15-sign-in-6-removed", "这台设备已从设备列表移除。重新登录就能继续用。")] {
            let app = DemoApp.launch(scene)
            XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", message)).firstMatch.waitForExistence(timeout: 10), "\(scene): the page does not say \(message)")
            XCTAssertTrue(app.buttons["用通行密钥登录"].firstMatch.isEnabled, "\(scene): the passkey button is grey")
            XCTAssertTrue(app.buttons["第一次用？输入设置码"].firstMatch.isHittable, "\(scene): the setup code button cannot be tapped")
            app.terminate()
        }
    }
}
