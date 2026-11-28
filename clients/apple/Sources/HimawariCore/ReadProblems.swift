import Foundation

public enum ReadProblemSource: String, Sendable, CaseIterable {
    case perceptionUpload = "perception_upload"
    case mirrorUpload = "mirror_upload"
    case health
    case contacts
}

public protocol ReadProblemTransport: Sendable {
    func reportReadProblem(source: String, code: String, failures: Int, sinceSeconds: Int) async throws
}

extension DeviceAPI: ReadProblemTransport {
    public func reportReadProblem(source: String, code: String, failures: Int, sinceSeconds: Int) async throws {
        struct Body: Encodable {
            let source: String
            let code: String
            let failures: Int
            let sinceSeconds: Int
        }
        let body = try JSONEncoder().encode(Body(source: source, code: code, failures: failures, sinceSeconds: sinceSeconds))
        _ = try await http.send(DeviceRequest(method: "POST", path: "read-problems", body: body))
    }
}

public enum ReadRetry {
    public static let first: TimeInterval = 30
    public static let longest: TimeInterval = 900

    public static func delay(afterFailures failures: Int) -> TimeInterval {
        guard failures > 0 else { return 0 }
        return min(longest, first * pow(2, Double(min(failures, 16) - 1)))
    }

    public static func code(_ error: Error) -> String {
        if let error = error as? DeviceAPIError {
            switch error {
            case let .server(status, code, _, _): return code ?? "HTTP_\(status)"
            case .invalidResponse: return "INVALID_RESPONSE"
            }
        }
        if let error = error as? URLError { return "NETWORK_\(abs(error.errorCode))" }
        return "READ_FAILED"
    }
}

public actor ReadProblems {
    public static let reportAfter = 3
    public static let reportEvery: TimeInterval = 3600

    private struct Open {
        var code: String
        var failures: Int
        let since: Date
        var reportedAt: Date?
    }

    private let transport: ReadProblemTransport?
    private let now: @Sendable () -> Date
    private var open: [ReadProblemSource: Open] = [:]

    public init(transport: ReadProblemTransport?, now: @escaping @Sendable () -> Date = Date.init) {
        self.transport = transport
        self.now = now
    }

    @discardableResult
    public func failed(_ source: ReadProblemSource, code: String) async -> Int {
        let at = now()
        var problem = open[source] ?? Open(code: code, failures: 0, since: at, reportedAt: nil)
        problem.code = code
        problem.failures += 1
        open[source] = problem
        let due = problem.reportedAt.map { at.timeIntervalSince($0) >= Self.reportEvery } ?? true
        guard problem.failures >= Self.reportAfter, due, let transport else { return problem.failures }
        let sinceSeconds = max(0, Int(at.timeIntervalSince(problem.since).rounded()))
        if (try? await transport.reportReadProblem(source: source.rawValue, code: code, failures: problem.failures, sinceSeconds: sinceSeconds)) != nil {
            open[source]?.reportedAt = at
        }
        return open[source]?.failures ?? problem.failures
    }

    public func succeeded(_ source: ReadProblemSource) {
        open[source] = nil
    }

    public func failures(_ source: ReadProblemSource) -> Int {
        open[source]?.failures ?? 0
    }
}
