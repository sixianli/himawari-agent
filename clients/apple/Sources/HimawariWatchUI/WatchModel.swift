#if os(watchOS)
import AVFoundation
import Foundation
import HimawariCore
import HimawariDesign
import Observation
import UserNotifications
import WidgetKit

public enum WatchPhase: Equatable {
    case unpaired(PairingProblem?)
    case submitting
    case waitingForConfirmation(number: String)
    case active
}

public enum TalkState: Equatable {
    case idle
    case sending
    case waiting
    case shown(String)
    case reading(first: String)
    case failed
}

public struct WatchScreen: Sendable, Equatable {
    public var width: Double
    public var height: Double
    public var fontSize: Double
    public var lineHeight: Double

    public init(width: Double, height: Double, fontSize: Double, lineHeight: Double) {
        self.width = width
        self.height = height
        self.fontSize = fontSize
        self.lineHeight = lineHeight
    }
}

@MainActor
@Observable
public final class WatchModel {
    public private(set) var phase: WatchPhase = .unpaired(nil)
    public private(set) var home: WatchHome?
    public private(set) var homeFailed = false
    public private(set) var settled: Set<String> = []
    public private(set) var acting: String?
    public private(set) var talk: TalkState = .idle
    public private(set) var configuration: DeviceConfiguration?

    @ObservationIgnored public let api: DeviceAPI
    @ObservationIgnored private let keys: SecureEnclaveKeyStore
    @ObservationIgnored private let keychain: KeychainValueStore
    @ObservationIgnored private let kind = DeviceKind.watch
    @ObservationIgnored private let releaseChannel: ReleaseChannel
    @ObservationIgnored private let complication: WatchComplicationStore
    @ObservationIgnored private let speaker = AVSpeechSynthesizer()
    @ObservationIgnored private var waiting: Task<Void, Never>?
    @ObservationIgnored private var talking: Task<Void, Never>?
    @ObservationIgnored private var requestIds: [String: String] = [:]
    @ObservationIgnored private var pendingSend: (thread: CreatedThread, message: OutgoingMessage)?
    @ObservationIgnored private var lastLink: String?
    @ObservationIgnored private var keysMadeFor: String?

    private static let recordAccount = "pairing-record"
    private static let reminderPrefix = "himawari.reminder."

    public init(bundle: Bundle = .main) {
        let service = (bundle.bundleIdentifier ?? "himawari.watch") + ".device"
        keys = SecureEnclaveKeyStore(service: service + ".keys")
        keychain = KeychainValueStore(service: service)
        let channel = bundle.object(forInfoDictionaryKey: "HimawariReleaseChannel") as? String
        releaseChannel = channel.flatMap(ReleaseChannel.init(rawValue:)).flatMap { $0 == .unrecognized ? nil : $0 } ?? .direct
        let group = bundle.object(forInfoDictionaryKey: "HimawariAppGroup") as? String ?? ""
        complication = WatchComplicationStore(appGroup: group)
        api = DeviceAPI(http: DeviceHTTPClient())
        restore()
    }

    #if DEBUG
    init(demoPhase: WatchPhase, home: WatchHome? = nil, talk: TalkState = .idle, homeFailed: Bool = false) {
        keys = SecureEnclaveKeyStore(service: "himawari.watch.demo.keys")
        keychain = KeychainValueStore(service: "himawari.watch.demo")
        releaseChannel = .direct
        complication = WatchComplicationStore(appGroup: "himawari.watch.demo")
        api = DeviceAPI(http: DeviceHTTPClient())
        phase = demoPhase
        self.home = home
        self.talk = talk
        self.homeFailed = homeFailed
    }
    #endif

    private var record: PairingRecord? {
        keychain.read(Self.recordAccount).flatMap { try? JSONDecoder().decode(PairingRecord.self, from: $0) }
    }

    private func save(_ record: PairingRecord?) throws {
        try keychain.write(Self.recordAccount, try record.map { try JSONEncoder().encode($0) })
    }

    private func use(_ record: PairingRecord) {
        api.http.use(DeviceCredentials(origin: record.origin, deviceId: record.deviceId, access: record.access, deviceKey: keys.signer(.device)))
    }

    private func restore() {
        let presence = [keychain.presence(Self.recordAccount), keys.presence(.device), keys.presence(.confirm)]
        let record = record
        switch RestoreDecision.decide(presence: presence, recordDecodes: record != nil) {
        case .unreadable:
            phase = .unpaired(.keysUnreadable)
            return
        case .forget:
            forget(problem: nil)
            return
        case .use:
            break
        }
        guard let record else { return }
        use(record)
        switch record.status {
        case .pending, .unrecognized:
            phase = .waitingForConfirmation(number: record.pairingNumber)
            waitForConfirmation()
        case .active:
            activate()
        case .revoked:
            forget(problem: .removed)
        }
    }

    public func receivePairingLink(_ link: String) {
        guard case .unpaired = phase else { return }
        lastLink = link
        submit(link)
    }

    public func retryPairing() {
        switch phase {
        case .unpaired(.keysUnreadable), .unpaired(.storageUnavailable):
            restore()
        case .unpaired(.stateUnknown):
            if let record {
                phase = .waitingForConfirmation(number: record.pairingNumber)
                waitForConfirmation()
            } else {
                restore()
            }
        default:
            guard let lastLink else {
                phase = .unpaired(nil)
                return
            }
            submit(lastLink)
        }
    }

    public func dismissProblem() {
        lastLink = nil
        keysMadeFor = nil
        phase = .unpaired(nil)
    }

    public func cancelPairing() {
        lastLink = nil
        keysMadeFor = nil
        forget(problem: nil)
    }

    private func submit(_ text: String) {
        guard phase != .submitting else { return }
        phase = .submitting
        Task {
            do {
                let invitation = try PairingInvitation.parse(text)
                if keysMadeFor != text || !keys.exists(.device) || !keys.exists(.confirm) {
                    keysMadeFor = nil
                    try keys.create(.device)
                    try keys.create(.confirm)
                    keysMadeFor = text
                }
                let deviceKey = keys.signer(.device)
                let confirmKey = keys.signer(.confirm)
                let device = try await api.pair(
                    invitation: invitation,
                    kind: kind,
                    name: WatchDeviceName.current(),
                    releaseChannel: releaseChannel,
                    deviceKey: deviceKey,
                    confirmKey: confirmKey
                )
                let devicePublicKey = try deviceKey.publicKeySPKI()
                let confirmPublicKey = try confirmKey.publicKeySPKI()
                if let reported = device.pairingNumber,
                   reported != PairingNumber.digits(devicePublicKey: devicePublicKey, confirmPublicKey: confirmPublicKey) {
                    throw DeviceAPIError.invalidResponse
                }
                let number = PairingNumber.display(devicePublicKey: devicePublicKey, confirmPublicKey: confirmPublicKey)
                let record = PairingRecord(origin: invitation.origin, deviceId: device.id, access: invitation.access, status: device.status, pairingNumber: number)
                try save(record)
                use(record)
                if device.status == .active {
                    activate()
                } else {
                    phase = .waitingForConfirmation(number: number)
                    waitForConfirmation()
                }
            } catch {
                if !PairingAttempt.mayHavePaired(error) {
                    keysMadeFor = nil
                    try? keys.delete(.device)
                    try? keys.delete(.confirm)
                }
                phase = .unpaired(PairingProblem.from(error))
            }
        }
    }

    private func waitForConfirmation() {
        waiting?.cancel()
        waiting = Task { [weak self] in
            var delay: UInt64 = 2
            while !Task.isCancelled {
                guard let self else { return }
                do {
                    configuration = try await api.configuration()
                    try? save(record.map { var updated = $0; updated.status = .active; return updated })
                    activate()
                    return
                } catch let error as DeviceAPIError where error.isRevoked {
                    forget(problem: .removed)
                    return
                } catch {
                    if let status = record?.status, ConfirmationWait.givesUp(waitingAs: status, after: error) {
                        phase = .unpaired(.stateUnknown)
                        return
                    }
                }
                try? await Task.sleep(nanoseconds: delay * 1_000_000_000)
                delay = min(delay * 2, 10)
            }
        }
    }

    private func activate() {
        waiting?.cancel()
        phase = .active
        Haptics.shared.report(.pairingSucceeded)
        Task { await refresh() }
    }

    private func forget(problem: PairingProblem?) {
        waiting?.cancel()
        talking?.cancel()
        configuration = nil
        home = nil
        settled = []
        try? keys.delete(.device)
        try? keys.delete(.confirm)
        try? save(nil)
        api.http.use(nil)
        complication.save(.unknown)
        WidgetCenter.shared.reloadAllTimelines()
        phase = .unpaired(problem)
    }

    public var refreshInterval: TimeInterval {
        TimeInterval(max(configuration?.heartbeatSeconds ?? 0, Self.systemRefreshFloor))
    }

    public static let systemRefreshFloor = 15 * 60

    public func refresh() async {
        guard phase == .active else { return }
        let locale = AnswerLocale.matching(preferredLanguages: Locale.preferredLanguages).rawValue
        do {
            if configuration == nil { configuration = try await api.configuration() }
            let next = try await api.watchHome(locale: locale)
            home = next
            homeFailed = false
            settled.formIntersection(Set(next.items.map(\.key)))
            complication.save(WatchComplicationState(home: next, at: Date()))
            WidgetCenter.shared.reloadAllTimelines()
            await scheduleReminders(next.upcoming)
        } catch let error as DeviceAPIError where error.isRevoked {
            forget(problem: .removed)
        } catch {
            homeFailed = true
        }
    }

    public var card: WatchCard? {
        guard let home else { return nil }
        let live = home.items.filter { !settled.contains($0.key) }
        return live.first { $0.awaitsOwner && $0.sentence != nil }.flatMap(WatchCard.init)
    }

    public func decide(_ card: WatchCard, _ action: HomeAction) {
        guard acting == nil else { return }
        acting = card.key
        let identity = [card.key, action.action, action.binding ?? ""].joined(separator: "\n")
        let requestId = requestIds[identity] ?? DeviceAPI.newActionRequestId()
        requestIds[identity] = requestId
        Task {
            do {
                try await api.act(key: card.key, action: action, requestId: requestId)
                requestIds[identity] = nil
                settled.insert(card.key)
                Haptics.shared.report(.messageSent)
            } catch {
                if case let DeviceAPIError.server(status, _, _, _) = error, (400 ..< 500).contains(status) { requestIds[identity] = nil }
                Haptics.shared.report(.taskFailed)
            }
            await refresh()
            acting = nil
        }
    }

    public func say(_ text: String, screen: WatchScreen) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, talk == .idle || talk == .failed else { return }
        talking?.cancel()
        talk = .sending
        talking = Task { [weak self] in
            await self?.run(trimmed, screen: screen)
        }
    }

    private func run(_ text: String, screen: WatchScreen) async {
        do {
            let locale = AnswerLocale.matching(preferredLanguages: Locale.preferredLanguages)
            if pendingSend?.message.text != text {
                let created = try await api.createThread(requestId: OutgoingMessage.newId(), answerLocale: locale)
                pendingSend = (created, OutgoingMessage(threadId: created.threadId, expectedRevision: created.threadRevision, text: text, createdAt: Date()))
            }
            guard let pending = pendingSend else { throw DeviceAPIError.invalidResponse }
            guard case .accepted = try await api.send(pending.message) else { throw DeviceAPIError.invalidResponse }
            pendingSend = nil
            talk = .waiting
            let ref = try await awaitAnswer(thread: pending.thread.threadId, after: pending.message.messageId)
            guard let reply = try await api.texts(for: [ref])[ref] else { throw DeviceAPIError.invalidResponse }
            finish(reply, screen: screen, locale: locale)
        } catch is CancellationError {
            talk = .idle
        } catch {
            Haptics.shared.report(.taskFailed)
            talk = .failed
        }
    }

    private func awaitAnswer(thread: String, after messageId: String) async throws -> String {
        let limit = TimeInterval(configuration?.connectionMaxSeconds ?? 0)
        let started = Date()
        var pause = 2.0
        while !Task.isCancelled {
            let detail = try await api.thread(thread)
            switch WatchReply.state(in: detail, after: messageId) {
            case let .answered(ref): return ref
            case .failed: throw DeviceAPIError.invalidResponse
            case .waiting: break
            }
            guard limit == 0 || Date().timeIntervalSince(started) < limit else { throw DeviceAPIError.invalidResponse }
            try await Task.sleep(for: .seconds(pause))
            pause = min(pause + 1, 5)
        }
        throw CancellationError()
    }

    private func finish(_ reply: String, screen: WatchScreen, locale: AnswerLocale) {
        Haptics.shared.report(.longTaskFinished)
        if WatchTextFit.fits(reply, width: screen.width, height: screen.height, fontSize: screen.fontSize, lineHeight: screen.lineHeight) {
            talk = .shown(reply)
        } else {
            talk = .reading(first: WatchReply.firstSentence(reply))
            let utterance = AVSpeechUtterance(string: reply)
            utterance.voice = AVSpeechSynthesisVoice(language: locale.rawValue)
            speaker.speak(utterance)
        }
    }

    public func stopReading() {
        speaker.stopSpeaking(at: .immediate)
        talk = .idle
    }

    public func finishTalk() {
        talking?.cancel()
        speaker.stopSpeaking(at: .immediate)
        pendingSend = nil
        talk = .idle
    }

    private func scheduleReminders(_ upcoming: [WatchUpcoming]) async {
        let center = UNUserNotificationCenter.current()
        guard (try? await center.requestAuthorization(options: [.alert, .sound])) == true else { return }
        let pending = await center.pendingNotificationRequests()
        center.removePendingNotificationRequests(withIdentifiers: pending.map(\.identifier).filter { $0.hasPrefix(Self.reminderPrefix) })
        let calendar = Calendar.current
        for reminder in WatchReminderPlan.due(upcoming, after: Date(), limit: WatchReminderPlan.systemPendingLimit) {
            let content = UNMutableNotificationContent()
            content.title = reminder.due.formatted(date: .omitted, time: .shortened)
            content.body = reminder.text
            content.sound = .default
            let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: reminder.due)
            let request = UNNotificationRequest(
                identifier: Self.reminderPrefix + reminder.reminderId,
                content: content,
                trigger: UNCalendarNotificationTrigger(dateMatching: parts, repeats: false)
            )
            try? await center.add(request)
        }
    }
}
#endif
