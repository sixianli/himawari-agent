import Foundation

public struct BackgroundWork: Decodable, Sendable, Equatable {
    public let matters: [Matter]

    public init(matters: [Matter]) {
        self.matters = matters
    }

    public struct Matter: Decodable, Sendable, Equatable, Identifiable {
        public let matter: String
        public let subthreads: [Subthread]
        public var id: String { matter }

        public init(matter: String, subthreads: [Subthread]) {
            self.matter = matter
            self.subthreads = subthreads
        }

        public var isOpen: Bool { subthreads.contains { $0.status == .open } }
        public var spentMicros: Int { subthreads.reduce(0) { $0 + $1.spentMicros } }
        public var updatedAt: Date { subthreads.map(\.updatedAt).max() ?? .distantPast }
    }

    public struct Subthread: Decodable, Sendable, Equatable, Identifiable {
        public enum Status: String, Decodable, Sendable { case open, returned, stopped }
        public enum Activity: String, Decodable, Sendable {
            case queued, running, idle, finished
            case waitingAnswer = "waiting_answer"
            case waitingResult = "waiting_result"
            case overBudget = "over_budget"
        }

        public let subthreadId: String
        public let status: Status
        public let activity: Activity
        public let openedAt: Date
        public let updatedAt: Date
        public let progress: String?
        public let progressAt: Date?
        public let runCount: Int
        public let spentMicros: Int
        public let budgetMicros: Int
        public let title: String?
        public let runs: [Run]
        public let exchanges: [Exchange]
        public let tasks: [TaskItem]
        public var id: String { subthreadId }

        public init(
            subthreadId: String,
            status: Status,
            activity: Activity,
            openedAt: Date,
            updatedAt: Date,
            progress: String? = nil,
            progressAt: Date? = nil,
            runCount: Int = 0,
            spentMicros: Int = 0,
            budgetMicros: Int,
            title: String? = nil,
            runs: [Run] = [],
            exchanges: [Exchange] = [],
            tasks: [TaskItem] = []
        ) {
            self.subthreadId = subthreadId
            self.status = status
            self.activity = activity
            self.openedAt = openedAt
            self.updatedAt = updatedAt
            self.progress = progress
            self.progressAt = progressAt
            self.runCount = runCount
            self.spentMicros = spentMicros
            self.budgetMicros = budgetMicros
            self.title = title
            self.runs = runs
            self.exchanges = exchanges
            self.tasks = tasks
        }
    }

    public struct Run: Decodable, Sendable, Equatable, Identifiable {
        public let runId: String
        public let status: String
        public let startedAt: Date
        public let updatedAt: Date
        public var id: String { runId }

        public init(runId: String, status: String, startedAt: Date, updatedAt: Date) {
            self.runId = runId
            self.status = status
            self.startedAt = startedAt
            self.updatedAt = updatedAt
        }
    }

    public struct Exchange: Decodable, Sendable, Equatable {
        public enum Direction: String, Decodable, Sendable {
            case toSubthread = "to_subthread"
            case toMain = "to_main"
        }

        public enum Kind: String, Decodable, Sendable {
            case brief, message, progress, question, stuck, result, budget
            case resultBoard = "result_board"
        }

        public let direction: Direction
        public let kind: Kind
        public let text: String
        public let at: Date

        public init(direction: Direction, kind: Kind, text: String, at: Date) {
            self.direction = direction
            self.kind = kind
            self.text = text
            self.at = at
        }
    }

    public struct TaskItem: Decodable, Sendable, Equatable, Identifiable {
        public enum Status: String, Decodable, Sendable {
            case pending
            case inProgress = "in_progress"
            case completed
        }

        public let number: Int
        public let status: Status
        public let subject: String?
        public let activeForm: String?
        public var id: Int { number }

        public init(number: Int, status: Status, subject: String? = nil, activeForm: String? = nil) {
            self.number = number
            self.status = status
            self.subject = subject
            self.activeForm = activeForm
        }
    }
}

public enum BackgroundWorkTag: Equatable, Sendable {
    case working
    case waitingAnswer
    case waitingResult
    case overBudget
    case done
    case stopped
}

public extension BackgroundWork {
    var openMatterCount: Int { matters.filter(\.isOpen).count }

    var overBudgetCount: Int {
        matters.flatMap(\.subthreads).filter { $0.status == .open && $0.activity == .overBudget }.count
    }

    var showsEntry: Bool { openMatterCount > 0 }

    func visibleMatters(now: Date, calendar: Calendar) -> [Matter] {
        let open = matters.filter(\.isOpen).sorted { $0.updatedAt > $1.updatedAt }
        let doneToday = matters
            .filter { !$0.isOpen && calendar.isDate($0.updatedAt, inSameDayAs: now) }
            .sorted { $0.updatedAt > $1.updatedAt }
        return open + doneToday
    }
}

public extension BackgroundWork.Subthread {
    var tag: BackgroundWorkTag? {
        switch status {
        case .returned: return .done
        case .stopped: return .stopped
        case .open: break
        }
        switch activity {
        case .running, .queued: return .working
        case .waitingAnswer: return .waitingAnswer
        case .waitingResult: return .waitingResult
        case .overBudget: return .overBudget
        case .finished: return .done
        case .idle: return nil
        }
    }

    var step: (current: Int, total: Int)? {
        guard !tasks.isEmpty else { return nil }
        let completed = tasks.filter { $0.status == .completed }.count
        return (min(completed + 1, tasks.count), tasks.count)
    }

    var currentDoing: String? {
        if let active = tasks.first(where: { $0.status == .inProgress }),
           let text = Self.present(active.activeForm) ?? Self.present(active.subject) {
            return text
        }
        return Self.present(progress)
    }

    var nearBudget: Bool { spentMicros * 10 > budgetMicros * 8 }

    var runsNewestFirst: [BackgroundWork.Run] {
        runs.sorted { $0.startedAt > $1.startedAt }
    }

    var exchangesInOrder: [BackgroundWork.Exchange] {
        exchanges.sorted { $0.at < $1.at }
    }

    internal static func present(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        return trimmed
    }
}

public enum MicroDollars {
    public static func dollars(_ micros: Int) -> String? {
        guard micros >= 10_000 else { return nil }
        let cents = (micros + 5_000) / 10_000
        return String(format: "%d.%02d", cents / 100, cents % 100)
    }
}

public extension DeviceAPI {
    static let threadGateway = "thread-v3"

    func backgroundWork() async throws -> BackgroundWork {
        struct Body: Encodable {
            let gateway: String
            let type: String
            let messageId: String
            let payload: [String: String]
        }
        struct Snapshot: Decodable { let work: BackgroundWork }
        let body = Body(gateway: Self.threadGateway, type: "thread.background_work", messageId: "device-" + RandomToken.base64URL(byteCount: 18), payload: [:])
        let data = try await http.send(DeviceRequest(method: "POST", path: "gateway", body: try JSONEncoder().encode(body)))
        do {
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .custom(Self.timestamp)
            return try decoder.decode(GatewayEnvelope<Snapshot>.self, from: data).payload.work
        } catch {
            throw DeviceAPIError.invalidResponse
        }
    }
}
