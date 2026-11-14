import Foundation

public protocol LenientServerValue: RawRepresentable, Codable where RawValue == String {
    static var fallback: Self { get }
}

extension LenientServerValue {
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        if let known = Self(rawValue: raw) {
            self = known
        } else {
            ServerValueDiagnostics.shared.noteFallback(type: String(describing: Self.self), raw: raw)
            self = Self.fallback
        }
    }
}

public struct UnknownServerValue: Sendable, Equatable {
    public let type: String
    public let raw: String
}

public final class ServerValueDiagnostics: @unchecked Sendable {
    public static let shared = ServerValueDiagnostics()
    public static let distinctLimit = 64

    private let lock = NSLock()
    private var seen = Set<String>()
    private var observer: (@Sendable (UnknownServerValue) -> Void)?

    public func observe(_ observer: (@Sendable (UnknownServerValue) -> Void)?) {
        lock.withLock { self.observer = observer }
    }

    public func reset() {
        lock.withLock { seen.removeAll() }
    }

    func noteFallback(type: String, raw: String) {
        let report = lock.withLock { () -> (@Sendable (UnknownServerValue) -> Void)? in
            guard let observer, seen.count < Self.distinctLimit, seen.insert("\(type)\u{0}\(raw)").inserted else { return nil }
            return observer
        }
        report?(UnknownServerValue(type: type, raw: String(raw.prefix(64))))
    }
}

extension ExecutionRecordKind: LenientServerValue {
    public static var fallback: ExecutionRecordKind { .unrecognized }
}

extension ExecutionPhase: LenientServerValue {
    public static var fallback: ExecutionPhase { .unrecognized }
}

extension ThreadStatus: LenientServerValue {
    public static var fallback: ThreadStatus { .active }
}

extension MessageRole: LenientServerValue {
    public static var fallback: MessageRole { .agent }
}

extension MessageStatus: LenientServerValue {
    public static var fallback: MessageStatus { .committed }
}

extension PairedDeviceStatus: LenientServerValue {
    public static var fallback: PairedDeviceStatus { .unrecognized }
}

extension DeviceKind: LenientServerValue {
    public static var fallback: DeviceKind { .unrecognized }
}

extension ReleaseChannel: LenientServerValue {
    public static var fallback: ReleaseChannel { .unrecognized }
}
