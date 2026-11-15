import Foundation
import HimawariCore

public struct DeviceResponse: Sendable {
    public let status: Int
    public let body: Data

    public init(status: Int, body: Data) {
        self.status = status
        self.body = body
    }
}

public struct ConfirmPrompt: Sendable, Hashable {
    public let reason: String

    public init(reason: String) {
        self.reason = reason
    }
}

public protocol DeviceTransport: Sendable {
    func post(path: String, json: Data, nonce: String?, confirm: ConfirmPrompt?) async throws -> DeviceResponse
    func download(path: String, query: [URLQueryItem]) async throws -> DeviceResponse
}

public extension DeviceTransport {
    func download(path: String, query: [URLQueryItem]) async throws -> DeviceResponse {
        DeviceResponse(status: 501, body: Data())
    }
}

public struct SignedDeviceTransport: DeviceTransport {
    private let http: DeviceHTTPClient
    private let confirmKey: DeviceKeySigner

    public init(http: DeviceHTTPClient, confirmKey: DeviceKeySigner) {
        self.http = http
        self.confirmKey = confirmKey
    }

    public func post(path: String, json: Data, nonce: String?, confirm: ConfirmPrompt?) async throws -> DeviceResponse {
        do {
            let body = try await http.send(
                DeviceRequest(
                    method: "POST",
                    path: path,
                    body: json,
                    nonce: nonce,
                    confirmSigner: confirm == nil ? nil : confirmKey,
                    confirmReason: confirm?.reason
                )
            )
            return DeviceResponse(status: 200, body: body)
        } catch let DeviceAPIError.server(status, code, _, reason) {
            var detail = ["code": code ?? ""]
            if let reason { detail["reasonCode"] = reason }
            let failure = ["error": detail]
            return DeviceResponse(status: status, body: (try? JSONEncoder().encode(failure)) ?? Data())
        }
    }

    public func download(path: String, query: [URLQueryItem]) async throws -> DeviceResponse {
        do {
            let body = try await http.send(DeviceRequest(method: "GET", path: path, query: query))
            return DeviceResponse(status: 200, body: body)
        } catch let DeviceAPIError.server(status, code, _, reason) {
            var detail = ["code": code ?? ""]
            if let reason { detail["reasonCode"] = reason }
            let failure = ["error": detail]
            return DeviceResponse(status: status, body: (try? JSONEncoder().encode(failure)) ?? Data())
        }
    }
}
