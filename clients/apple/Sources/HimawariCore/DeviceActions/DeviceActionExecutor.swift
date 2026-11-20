import Foundation

public enum DeviceActionStep: Sendable, Equatable {
    case reported(id: String, outcome: DeviceActionOutcome, readBack: Bool)
    case replayed(id: String)
    case held(id: String)
}

public actor DeviceActionExecutor {
    private let transport: DeviceActionTransport
    private let journal: DeviceActionJournal
    private let handlers: [String: DeviceActionHandler]
    private let allHandlers: [DeviceActionHandler]
    private let now: @Sendable () -> Date
    private let locale: AnswerLocale
    private var running = false
    private var again = false
    private var steps: [DeviceActionStep] = []

    public init(
        transport: DeviceActionTransport,
        journal: DeviceActionJournal,
        handlers: [DeviceActionHandler],
        locale: AnswerLocale = .matching(preferredLanguages: Locale.preferredLanguages),
        now: @escaping @Sendable () -> Date = Date.init
    ) {
        self.transport = transport
        self.journal = journal
        allHandlers = handlers
        var byName: [String: DeviceActionHandler] = [:]
        for handler in handlers {
            for name in handler.names where byName[name] == nil { byName[name] = handler }
        }
        self.handlers = byName
        self.locale = locale
        self.now = now
    }

    public var implemented: [String] { handlers.keys.sorted() }

    public func supported() async -> [String] {
        var names: [String] = []
        for handler in allHandlers where await handler.permission.status() == .authorized {
            names += handler.names
        }
        return Array(Set(names)).sorted()
    }

    public func permissionIds() -> [String: String] {
        handlers.mapValues(\.permission.id)
    }

    public func permissions() -> [DevicePermission] {
        var seen = Set<String>()
        return allHandlers.map(\.permission).filter { seen.insert($0.id).inserted }
    }

    @discardableResult
    public func run() async -> [DeviceActionStep] {
        if running {
            again = true
            return []
        }
        running = true
        steps = []
        defer { running = false }
        repeat {
            again = false
            await pass()
        } while again
        return steps
    }

    private func pass() async {
        do {
            var seen = Set<String>()
            if journal.lost {
                let reopened = try await transport.reopenActions()
                try journal.save(DeviceActionJournalFile())
                for delivery in reopened {
                    seen.insert(delivery.id)
                    await process(delivery.checkingOnly)
                }
            }
            await announceSupported()
            await refreshPolicy()
            await resendFinished()
            while true {
                let claimed = try await transport.claimActions()
                let fresh = claimed.filter { !seen.contains($0.id) }
                if fresh.isEmpty { break }
                for delivery in fresh {
                    seen.insert(delivery.id)
                    await process(delivery)
                }
            }
        } catch {}
    }

    private func announceSupported() async {
        let names = await supported()
        guard let file = try? journal.load(), file.reportedSupported != names else { return }
        guard (try? await transport.reportSupportedActions(names)) != nil else { return }
        try? journal.update { $0.reportedSupported = names }
    }

    public func forgetAnnouncedSupport() {
        try? journal.update { $0.reportedSupported = nil }
    }

    private func refreshPolicy() async {
        guard let policy = try? await transport.actionPolicy() else { return }
        try? journal.update { $0.blocked = policy.blocked.sorted() }
    }

    private func resendFinished() async {
        guard let entries = try? journal.entries() else { return }
        let current = now()
        for entry in entries where entry.stage == .finished {
            if entry.refused {
                if (entry.keepUntil ?? .distantPast) < current {
                    try? journal.update { $0.entries[entry.id] = nil }
                }
                continue
            }
            if let report = entry.report { await send(report) }
        }
    }

    private func blocked(_ name: String) -> Bool {
        ((try? journal.load())?.blocked ?? []).contains(name)
    }

    private func process(_ delivery: DeviceActionDelivery) async {
        let entry: DeviceActionJournalEntry?
        do {
            entry = try journal.entry(delivery.id)
        } catch {
            steps.append(.held(id: delivery.id))
            return
        }
        if let entry, entry.stage == .finished, let report = entry.report {
            await send(report)
            steps.append(.replayed(id: delivery.id))
            return
        }
        if delivery.mode == .verify || entry.map({ $0.stage != .received }) == true {
            await verify(delivery, made: entry?.made, before: entry?.before)
            return
        }
        await perform(delivery)
    }

    private func perform(_ delivery: DeviceActionDelivery) async {
        let handler = handlers[delivery.action]
        let permission = await handler?.permission.status()
        if let refusal = DeviceActionGate.refusal(
            delivery,
            implemented: handler?.handles(delivery) ?? false,
            blocked: blocked(delivery.action),
            permission: permission,
            permissionName: handler?.permission.name,
            settingsPath: handler?.permission.settingsPath,
            now: now()
        ) {
            return await finish(delivery, .failed, readBack: false, evidence: nil, reason: refusal)
        }
        guard let handler else { return }
        guard record(delivery, stage: .received) else { return }
        var before: JSONObject?
        if delivery.snapshotBefore {
            do {
                before = try await handler.snapshot(delivery)
            } catch let failure as DeviceActionFailure {
                return await finish(delivery, .failed, readBack: false, evidence: nil, reason: failure.reason)
            } catch {
                return await finish(delivery, .failed, readBack: false, evidence: nil, reason: .snapshotFailed)
            }
            if before == nil {
                return await finish(delivery, .failed, readBack: false, evidence: nil, reason: .targetMissing)
            }
        }
        guard record(delivery, stage: .started, before: before) else { return }
        let made: JSONObject?
        do {
            made = try await handler.perform(delivery)
            _ = record(delivery, stage: .started, before: before, made: made)
        } catch let failure as DeviceActionFailure {
            return await finish(delivery, .failed, readBack: false, evidence: Self.evidence(before: before), reason: failure.reason)
        } catch {
            return await verify(delivery, made: nil, before: before)
        }
        if delivery.readBack == .none {
            return await finish(delivery, .succeeded, readBack: false, evidence: Self.evidence(made: made, before: before), reason: nil)
        }
        await settle(delivery, made: made, before: before, differs: .readBackDiffers)
    }

    private func verify(_ delivery: DeviceActionDelivery, made: JSONObject?, before: JSONObject?) async {
        guard let handler = handlers[delivery.action], handler.handles(delivery), await handler.permission.status() == .authorized else {
            return await finish(delivery, .resultUnknown, readBack: false, evidence: nil, reason: .cannotCheck)
        }
        if delivery.readBack == .none {
            guard handler.readOnly.contains(delivery.action) else {
                return await finish(delivery, .resultUnknown, readBack: false, evidence: Self.evidence(made: made, before: before), reason: .cannotCheck)
            }
            do {
                let result = try await handler.perform(delivery)
                return await finish(delivery, .succeeded, readBack: true, evidence: Self.evidence(made: result, before: nil), reason: nil)
            } catch {
                return await finish(delivery, .resultUnknown, readBack: false, evidence: nil, reason: .cannotCheck)
            }
        }
        await settle(delivery, made: made, before: before, differs: .notDoneOnCheck)
    }

    private func settle(_ delivery: DeviceActionDelivery, made: JSONObject?, before: JSONObject?, differs: DeviceActionReason) async {
        guard let handler = handlers[delivery.action] else { return }
        let reading = (try? await handler.readBack(delivery, made: made)) ?? .unreadable
        switch reading {
        case let .matches(found):
            await finish(delivery, .succeeded, readBack: true, evidence: Self.evidence(made: made, found: found, before: before), reason: nil)
        case let .differs(found):
            await finish(delivery, .failed, readBack: true, evidence: Self.evidence(made: made, found: found, before: before), reason: differs)
        case .unreadable:
            await finish(delivery, .resultUnknown, readBack: false, evidence: Self.evidence(made: made, before: before), reason: .cannotCheck)
        }
    }

    static func evidence(made: JSONObject? = nil, found: JSONObject? = nil, before: JSONObject? = nil) -> JSONObject? {
        var evidence: JSONObject = [:]
        if let made {
            evidence["done"] = .object(made)
            if let eventId = made["eventId"]?.string, !eventId.isEmpty { evidence["eventId"] = .string(eventId) }
        }
        if let found { evidence["readBack"] = .object(found) }
        if let before { evidence["before"] = .object(before) }
        return evidence.isEmpty ? nil : evidence
    }

    private func record(_ delivery: DeviceActionDelivery, stage: DeviceActionStage, before: JSONObject? = nil, made: JSONObject? = nil) -> Bool {
        do {
            try journal.update { file in
                var entry = file.entries[delivery.id] ?? DeviceActionJournalEntry(
                    id: delivery.id, action: delivery.action, stage: stage, before: nil, made: nil, report: nil, updatedAt: now()
                )
                entry.stage = stage
                if let before { entry.before = before }
                if let made { entry.made = made }
                entry.updatedAt = now()
                file.entries[delivery.id] = entry
            }
            return true
        } catch {
            steps.append(.held(id: delivery.id))
            return false
        }
    }

    private func finish(_ delivery: DeviceActionDelivery, _ outcome: DeviceActionOutcome, readBack: Bool, evidence: JSONObject?, reason: DeviceActionReason?) async {
        let report = DeviceActionReport(id: delivery.id, outcome: outcome, readBack: readBack, evidence: evidence, reason: reason?.text(locale))
        do {
            try journal.update { file in
                var entry = file.entries[delivery.id] ?? DeviceActionJournalEntry(
                    id: delivery.id, action: delivery.action, stage: .finished, before: nil, made: nil, report: nil, updatedAt: now()
                )
                entry.stage = .finished
                entry.report = report
                entry.keepUntil = delivery.expiry
                entry.updatedAt = now()
                file.entries[delivery.id] = entry
            }
        } catch {
            steps.append(.held(id: delivery.id))
            return
        }
        steps.append(.reported(id: delivery.id, outcome: outcome, readBack: readBack))
        await send(report)
    }

    private func send(_ report: DeviceActionReport) async {
        do {
            var reply = try await transport.reportAction(report)
            if case .refused(status: 400, _) = reply, report.evidence != nil {
                let lean = DeviceActionReport(id: report.id, outcome: report.outcome, readBack: report.readBack, evidence: nil, reason: report.reason)
                reply = try await transport.reportAction(lean)
            }
            switch reply {
            case .recorded:
                try? journal.update { $0.entries[report.id] = nil }
            case .refused:
                try? journal.update { $0.entries[report.id]?.refused = true }
            }
        } catch {}
    }
}

public enum DeviceActionGate {
    public static func refusal(
        _ delivery: DeviceActionDelivery,
        implemented: Bool,
        blocked: Bool,
        permission: DevicePermissionStatus?,
        permissionName: LocalizedLine?,
        settingsPath: LocalizedLine?,
        now: Date
    ) -> DeviceActionReason? {
        if !implemented { return .notSupported }
        if blocked { return .blockedByPolicy }
        guard let expiry = delivery.expiry, expiry > now else { return .expired }
        switch permission {
        case .authorized: return nil
        case .notDetermined: return .permissionNotAsked(permissionName ?? [:])
        case .unavailable: return .permissionUnavailable(permissionName ?? [:])
        case .denied, nil: return .permission(permissionName ?? [:], settings: settingsPath ?? [:])
        }
    }
}
