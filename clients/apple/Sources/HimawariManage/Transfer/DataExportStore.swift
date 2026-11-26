import Foundation
import Observation
#if canImport(CryptoKit)
import CryptoKit
#endif

public struct ExportedArchive: Equatable, Sendable {
    public let fileName: String
    public let data: Data
    public let memories: Int
    public let rules: Int
    public let withheld: Int
}

@MainActor
@Observable
public final class DataExportStore {
    public enum Phase: Equatable {
        case idle
        case running(read: Int?, total: Int?)
        case ready(ExportedArchive)
        case failed(String?)
    }

    struct Status: Decodable {
        struct Progress: Decodable {
            let textsRead: Int
            let textsTotal: Int
        }

        struct Result: Decodable {
            let fileName: String
            let sizeBytes: Int
            let sha256: String
            let memories: Int
            let rules: Int
            let withheld: Int
        }

        let exportId: String
        let state: String
        let failureCode: String?
        let progress: Progress?
        let result: Result?
    }

    public private(set) var phase: Phase = .idle

    @ObservationIgnored private let gateway: ManageGateway
    @ObservationIgnored private let download: @Sendable (String) async throws -> Data
    @ObservationIgnored private let wait: @Sendable () async throws -> Void

    public init(
        gateway: ManageGateway,
        download: @escaping @Sendable (String) async throws -> Data,
        wait: @escaping @Sendable () async throws -> Void = { try await Task.sleep(for: .seconds(1)) }
    ) {
        self.gateway = gateway
        self.download = download
        self.wait = wait
    }

    public var running: Bool {
        if case .running = phase { return true }
        return false
    }

    public func reset() {
        if !running { phase = .idle }
    }

    public func start(reason: String) async {
        guard !running else { return }
        phase = .running(read: nil, total: nil)
        do {
            let started = try await gateway.command(
                .v2,
                "data.export.start",
                payload: [:],
                options: ManageCommandOptions(risk: "medium", confirmReason: reason)
            )
            struct Started: Decodable { let resultRef: String }
            guard let exportId = try? JSONDecoder().decode(Started.self, from: started).resultRef else {
                phase = .failed(nil)
                return
            }
            while true {
                let data = try await gateway.read(.v2, "data.export.status.read", payload: ["exportId": .string(exportId)])
                let status = try JSONDecoder().decode(Snapshot<Status>.self, from: data).payload
                switch status.state {
                case "running":
                    phase = .running(read: status.progress?.textsRead, total: status.progress?.textsTotal)
                    try await wait()
                case "ready":
                    guard let result = status.result else {
                        phase = .failed(nil)
                        return
                    }
                    let archive = try await download(exportId)
                    guard archive.count == result.sizeBytes, Self.hex(archive) == result.sha256 else {
                        phase = .failed("DATA_EXPORT_DOWNLOAD_DAMAGED")
                        return
                    }
                    phase = .ready(
                        ExportedArchive(
                            fileName: result.fileName,
                            data: archive,
                            memories: result.memories,
                            rules: result.rules,
                            withheld: result.withheld
                        )
                    )
                    return
                default:
                    phase = .failed(status.failureCode ?? status.state)
                    return
                }
            }
        } catch is CancellationError {
            phase = .idle
        } catch let ManageGatewayError.rejected(_, code, _) {
            phase = .failed(code)
        } catch {
            phase = .failed(nil)
        }
    }

    nonisolated static func hex(_ data: Data) -> String {
        #if canImport(CryptoKit)
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        #else
        ""
        #endif
    }
}
