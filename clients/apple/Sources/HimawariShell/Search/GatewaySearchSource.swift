import Foundation
import HimawariCore
import HimawariManage

struct GatewaySearchSource: SearchSource {
    let gateway: ManageGateway

    init(api: DeviceAPI, confirmKey: DeviceKeySigner) {
        gateway = ManageGateway(transport: SignedDeviceTransport(http: api.http, confirmKey: confirmKey))
    }

    func ask(_ question: String?) async throws -> SearchAnswer {
        let locale = HomeLocale.matching(Locale.preferredLanguages).rawValue
        let query: JSONValue = question.map { .string($0) } ?? .null
        let data = try await gateway.read(.v2, "search.ask.read", payload: ["query": query, "locale": .string(locale)])
        return try SearchAnswer.decode(data)
    }
}
