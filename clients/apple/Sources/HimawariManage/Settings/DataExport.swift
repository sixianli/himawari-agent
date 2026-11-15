import Foundation
import HimawariCore
import Observation

public struct DataExportResult: Decodable, Sendable, Equatable {
    public let downloadPath: String
    public let fileName: String
    public let sizeBytes: Int
    public let sha256: String
    public let memories: Int
    public let rules: Int
    public let withheld: Int
    public let expiresAt: String
}

public struct DataExportProgress: Decodable, Sendable, Equatable {
    public let textsRead: Int
    public let textsTotal: Int

    public var fraction: Double? {
        textsTotal > 0 ? min(1, Double(textsRead) / Double(textsTotal)) : nil
    }
}

struct DataExportStatus: Decodable {
    let exportId: String
    let state: String
    let progress: DataExportProgress?
    let result: DataExportResult?
}

struct CommandReceipt: Decodable {
    let resultRef: String?
}

public enum DataExportStage: Equatable, Sendable {
    case idle
    case starting
    case packing(DataExportProgress?)
    case ready(DataExportResult)
    case expired
    case failed
}

@MainActor
@Observable
public final class DataExportSession {
    public private(set) var stage: DataExportStage = .idle

    @ObservationIgnored private let gateway: ManageGateway
    @ObservationIgnored private let pollInterval: Duration
    @ObservationIgnored private var exportId: String?
    @ObservationIgnored private var polling = false

    init(gateway: ManageGateway, pollInterval: Duration = .seconds(1)) {
        self.gateway = gateway
        self.pollInterval = pollInterval
    }

    init(gateway: ManageGateway, fixed stage: DataExportStage) {
        self.gateway = gateway
        pollInterval = .seconds(1)
        self.stage = stage
        if case .ready = stage { exportId = "demo" }
    }

    public func start(reason: String) async {
        stage = .starting
        do {
            let data = try await gateway.command(.v2, "data.export.start", payload: [:], options: ManageCommandOptions(confirmReason: reason))
            guard let id = try JSONDecoder().decode(CommandReceipt.self, from: data).resultRef else {
                stage = .failed
                return
            }
            exportId = id
            stage = .packing(nil)
            await follow()
        } catch {
            stage = .failed
        }
    }

    public func follow() async {
        guard let exportId, !polling else { return }
        polling = true
        defer { polling = false }
        while !Task.isCancelled, self.exportId == exportId {
            do {
                let data = try await gateway.read(.v2, "data.export.status.read", payload: ["exportId": .string(exportId)])
                let status = try JSONDecoder().decode(Snapshot<DataExportStatus>.self, from: data).payload
                guard self.exportId == exportId else { return }
                switch status.state {
                case "running":
                    stage = .packing(status.progress)
                case "ready":
                    if let result = status.result { stage = .ready(result) } else { stage = .failed }
                    return
                case "expired":
                    stage = .expired
                    return
                case "cancelled":
                    reset()
                    return
                default:
                    stage = .failed
                    return
                }
            } catch ManageGatewayError.rejected(404, _, _) {
                stage = .expired
                return
            } catch {
                stage = .failed
                return
            }
            try? await Task.sleep(for: pollInterval)
        }
    }

    public func archiveFile(named fileName: String) async throws -> URL {
        guard let exportId else { throw ManageGatewayError.malformedResponse }
        let data = try await gateway.downloadArchive(exportId: exportId)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(URL(fileURLWithPath: fileName).lastPathComponent)
        try data.write(to: url, options: .atomic)
        return url
    }

    public func cancel() async throws {
        guard let exportId else {
            reset()
            return
        }
        _ = try await gateway.command(.v2, "data.export.cancel", payload: ["exportId": .string(exportId)], options: ManageCommandOptions(confirmReason: M.stopExport))
        reset()
    }

    private func reset() {
        exportId = nil
        stage = .idle
    }
}
