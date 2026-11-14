import Foundation

public protocol LenientServerValue: RawRepresentable, Codable where RawValue == String {
    static var fallback: Self { get }
}

extension LenientServerValue {
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? Self.fallback
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
