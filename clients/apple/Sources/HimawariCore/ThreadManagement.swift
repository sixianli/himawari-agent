import Foundation

public struct ThreadTaskBinding: Sendable, Equatable {
    public let taskId: String
    public let revision: Int
    public let status: String

    public var isActive: Bool { status == "active" }
}

public struct ThreadDeletionImpact: Sendable, Equatable {
    public let threadId: String
    public let threadRevision: Int
    public let tasks: [ThreadTaskBinding]
    public let deletionAllowed: Bool

    public var activeTasks: [ThreadTaskBinding] { tasks.filter(\.isActive) }
}

public enum ThreadGatewayQuery {
    public static let gateway = "thread-v3"
    public static let list = "thread.list"
    public static let deletionImpact = "thread.deletion_impact"
}

public enum ThreadGatewayCommand {
    public static let rename = "thread.rename"
    public static let pin = "thread.pin"
    public static let archive = "thread.archive"
    public static let restore = "thread.restore"
    public static let trash = "thread.trash"
    public static let fork = "thread.fork"
    public static let setAnswerLocale = "thread.set_answer_locale"
    public static let resolveTask = "thread.task.resolve"
}

public enum ThreadForkSource {
    public static func latest(in messages: [ThreadMessage]) -> (turnId: String, watermark: Int)? {
        guard let last = messages.filter({ $0.status == .committed && $0.turnId != nil }).max(by: { $0.sequence < $1.sequence }),
              let turnId = last.turnId
        else { return nil }
        return (turnId, last.sequence)
    }
}

public enum ThreadSearch {
    public static func matches(_ query: String, in fields: [String?]) -> Bool {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return true }
        return fields.contains { $0?.range(of: needle, options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive]) != nil }
    }
}

struct ThreadGatewayRequest<Payload: Encodable>: Encodable {
    let gateway: String
    let type: String
    let messageId: String
    let idempotencyKey: String?
    let payload: Payload
}

extension DeviceAPI {
    public static let managedReasonCode = "owner_requested"

    static func gatewayIdentifier(_ prefix: String) -> String {
        prefix + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }

    public func protectedText(_ content: String) async throws -> String {
        struct Body: Encodable {
            let idempotencyKey: String
            let content: String
            let dataClassification: String
        }
        struct Created: Decodable { let payloadRef: String }
        let body = Body(idempotencyKey: Self.gatewayIdentifier("device-text-"), content: content, dataClassification: "private")
        let data = try await http.send(DeviceRequest(method: "POST", path: "payloads/text/new", body: try JSONEncoder().encode(body)))
        return try decode(Created.self, data).payloadRef
    }

    public func threadCommand<Payload: Encodable>(_ type: String, payload: Payload) async throws -> CommandOutcome {
        let body = ThreadGatewayRequest(
            gateway: ThreadGatewayQuery.gateway,
            type: type,
            messageId: Self.gatewayIdentifier("device-"),
            idempotencyKey: Self.gatewayIdentifier("device-"),
            payload: payload
        )
        let data = try await http.send(DeviceRequest(method: "POST", path: "gateway", body: try JSONEncoder().encode(body)))
        return try outcome(data)
    }

    func threadQuery<Payload: Encodable>(_ type: String, payload: Payload) async throws -> Data {
        let body = ThreadGatewayRequest(
            gateway: ThreadGatewayQuery.gateway,
            type: type,
            messageId: Self.gatewayIdentifier("device-"),
            idempotencyKey: nil,
            payload: payload
        )
        return try await http.send(DeviceRequest(method: "POST", path: "gateway", body: try JSONEncoder().encode(body)))
    }

    public func threads(statuses: [ThreadStatus], after cursor: String? = nil) async throws -> ThreadCollection {
        struct Payload: Encodable {
            let statuses: [ThreadStatus]
            let pinnedOnly: Bool
            let afterCursor: String?
            let limit: Int
            func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: Keys.self)
                try container.encode(statuses, forKey: .statuses)
                try container.encode(pinnedOnly, forKey: .pinnedOnly)
                try container.encode(afterCursor, forKey: .afterCursor)
                try container.encode(limit, forKey: .limit)
            }
            enum Keys: String, CodingKey { case statuses, pinnedOnly, afterCursor, limit }
        }
        let data = try await threadQuery(
            ThreadGatewayQuery.list,
            payload: Payload(statuses: statuses, pinnedOnly: false, afterCursor: cursor, limit: 100)
        )
        return try decode(GatewayEnvelope<ThreadCollection>.self, data).payload
    }

    public func allThreads(statuses: [ThreadStatus]) async throws -> [ThreadSummary] {
        var collected: [ThreadSummary] = []
        var cursor: String?
        var seen = Set<String>()
        repeat {
            let page = try await threads(statuses: statuses, after: cursor)
            collected += page.threads
            cursor = page.nextCursor
            if let cursor, !seen.insert(cursor).inserted { throw DeviceAPIError.invalidResponse }
        } while cursor != nil
        return collected
    }

    public func deletionImpact(threadId: String) async throws -> ThreadDeletionImpact {
        struct Payload: Encodable { let threadId: String }
        struct Binding: Decodable {
            let taskId: String
            let revision: Int
            let status: String
        }
        struct Snapshot: Decodable {
            let threadId: String
            let threadRevision: Int
            let associatedTasks: [Binding]
            let deletionAllowed: Bool
        }
        let data = try await threadQuery(ThreadGatewayQuery.deletionImpact, payload: Payload(threadId: threadId))
        let snapshot = try decode(GatewayEnvelope<Snapshot>.self, data).payload
        return ThreadDeletionImpact(
            threadId: snapshot.threadId,
            threadRevision: snapshot.threadRevision,
            tasks: snapshot.associatedTasks.map { ThreadTaskBinding(taskId: $0.taskId, revision: $0.revision, status: $0.status) },
            deletionAllowed: snapshot.deletionAllowed
        )
    }

    public func renameThread(_ threadId: String, expectedRevision: Int, title: String) async throws -> CommandOutcome {
        struct Payload: Encodable {
            let threadId: String
            let expectedRevision: Int
            let titleRef: String
            let titleSource: String
            let resultRef: String
        }
        let titleRef = try await protectedText(title)
        let resultRef = try await protectedText("thread-action:rename")
        return try await threadCommand(
            ThreadGatewayCommand.rename,
            payload: Payload(threadId: threadId, expectedRevision: expectedRevision, titleRef: titleRef, titleSource: "owner", resultRef: resultRef)
        )
    }

    public func pinThread(_ threadId: String, expectedRevision: Int, pinOrder: Int?) async throws -> CommandOutcome {
        struct Payload: Encodable {
            let threadId: String
            let expectedRevision: Int
            let pinOrder: Int?
            let resultRef: String
            func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: Keys.self)
                try container.encode(threadId, forKey: .threadId)
                try container.encode(expectedRevision, forKey: .expectedRevision)
                try container.encode(pinOrder, forKey: .pinOrder)
                try container.encode(resultRef, forKey: .resultRef)
            }
            enum Keys: String, CodingKey { case threadId, expectedRevision, pinOrder, resultRef }
        }
        let resultRef = try await protectedText("thread-action:pin")
        return try await threadCommand(
            ThreadGatewayCommand.pin,
            payload: Payload(threadId: threadId, expectedRevision: expectedRevision, pinOrder: pinOrder, resultRef: resultRef)
        )
    }

    public func lifecycleThread(_ type: String, threadId: String, expectedRevision: Int) async throws -> CommandOutcome {
        struct Payload: Encodable {
            let threadId: String
            let expectedRevision: Int
            let reasonCode: String
            let resultRef: String
        }
        let resultRef = try await protectedText("thread-action:\(type.dropFirst("thread.".count))")
        return try await threadCommand(
            type,
            payload: Payload(threadId: threadId, expectedRevision: expectedRevision, reasonCode: Self.managedReasonCode, resultRef: resultRef)
        )
    }

    public func setThreadAnswerLocale(_ threadId: String, expectedRevision: Int, locale: AnswerLocale) async throws -> CommandOutcome {
        struct Payload: Encodable {
            let threadId: String
            let expectedRevision: Int
            let answerLocale: AnswerLocale
            let resultRef: String
        }
        let resultRef = try await protectedText("thread-action:set_answer_locale")
        return try await threadCommand(
            ThreadGatewayCommand.setAnswerLocale,
            payload: Payload(threadId: threadId, expectedRevision: expectedRevision, answerLocale: locale, resultRef: resultRef)
        )
    }

    public func forkThread(from threadId: String, turnId: String, watermark: Int) async throws -> CreatedThread {
        struct Payload: Encodable {
            let sourceThreadId: String
            let sourceTurnId: String
            let sourceWatermark: Int
            let targetThreadId: String
            let summaryRefs: [String]
            let policyRefs: [String]
            let resultRef: String
        }
        let resultRef = try await protectedText("thread-action:fork")
        let targetThreadId = Self.gatewayIdentifier("thread-fork:")
        let outcome = try await threadCommand(
            ThreadGatewayCommand.fork,
            payload: Payload(
                sourceThreadId: threadId,
                sourceTurnId: turnId,
                sourceWatermark: watermark,
                targetThreadId: targetThreadId,
                summaryRefs: [],
                policyRefs: [],
                resultRef: resultRef
            )
        )
        guard case let .accepted(revision, _) = outcome else { throw DeviceAPIError.invalidResponse }
        return CreatedThread(threadId: targetThreadId, threadRevision: revision)
    }

    public func pauseTask(_ task: ThreadTaskBinding, in threadId: String) async throws -> CommandOutcome {
        struct Payload: Encodable {
            let threadId: String
            let taskId: String
            let expectedTaskRevision: Int
            let action: String
            let targetThreadId: String?
            let reasonCode: String
            let resultRef: String
            func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: Keys.self)
                try container.encode(threadId, forKey: .threadId)
                try container.encode(taskId, forKey: .taskId)
                try container.encode(expectedTaskRevision, forKey: .expectedTaskRevision)
                try container.encode(action, forKey: .action)
                try container.encode(targetThreadId, forKey: .targetThreadId)
                try container.encode(reasonCode, forKey: .reasonCode)
                try container.encode(resultRef, forKey: .resultRef)
            }
            enum Keys: String, CodingKey { case threadId, taskId, expectedTaskRevision, action, targetThreadId, reasonCode, resultRef }
        }
        let resultRef = try await protectedText("thread-action:task.resolve")
        return try await threadCommand(
            ThreadGatewayCommand.resolveTask,
            payload: Payload(
                threadId: threadId,
                taskId: task.taskId,
                expectedTaskRevision: task.revision,
                action: "pause",
                targetThreadId: nil,
                reasonCode: Self.managedReasonCode,
                resultRef: resultRef
            )
        )
    }
}
