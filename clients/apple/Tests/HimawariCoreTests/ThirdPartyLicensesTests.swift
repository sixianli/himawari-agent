import Foundation
import Testing
@testable import HimawariCore

struct ThirdPartyLicensesTests {
    @Test func everyPackageTheAppPullsInIsListedOnTheAboutPage() throws {
        let manifest = try String(contentsOfFile: "Package.swift", encoding: .utf8)
        let resolved = try String(contentsOfFile: "Package.resolved", encoding: .utf8)
        let urls = (manifest + resolved).matches(of: /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?(?:\.git)?(?="|$)/).map { String($0.output).replacingOccurrences(of: ".git", with: "") }
        #expect(!urls.isEmpty)
        let listed = Set(ThirdPartyLicenses.all.map(\.repository))
        for url in Set(urls) {
            #expect(listed.contains(url), "\(url) is used but not on the About page")
        }
    }
}
