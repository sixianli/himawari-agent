import Foundation

public struct ListeningBatteryMeter: Codable, Sendable, Equatable {
    public private(set) var day: String
    public private(set) var used: Double
    private var lastLevel: Double?

    public init(day: String) {
        self.day = day
        used = 0
    }

    public var usedPercent: Int {
        Int(used.rounded(.down))
    }

    public mutating func sample(level: Double?, charging: Bool, listening: Bool, day: String) {
        if day != self.day {
            self.day = day
            used = 0
            lastLevel = nil
        }
        guard let level, level >= 0, level <= 1 else {
            lastLevel = nil
            return
        }
        if listening, !charging, let lastLevel, level < lastLevel {
            used += (lastLevel - level) * 100
        }
        lastLevel = listening && !charging ? level : nil
    }
}

public struct ListeningLimits: Sendable, Equatable {
    public struct Entry: Sendable, Equatable {
        public let limit: Int64?
        public let used: Int64
        public let resetsAt: Date?
    }

    public let audio: Entry?
    public let battery: Entry?

    public static let audioKey = "perception.audio.daily"
    public static let batteryKey = "device.battery.listening"

    public var audioSpent: Bool {
        guard let audio, let limit = audio.limit else { return false }
        return audio.used >= limit
    }

    public func batterySpent(usedPercent: Int) -> Bool {
        guard let limit = battery?.limit else { return false }
        return Int64(usedPercent) >= limit
    }
}

extension DeviceAPI {
    public func listeningLimits() async throws -> ListeningLimits {
        struct Item: Decodable {
            let key: String
            let limit: Int64?
            let used: Int64
            let resetsAt: String?
        }
        struct Result: Decodable { let limits: [Item] }
        let data = try await http.send(DeviceRequest(method: "GET", path: "usage"))
        let items = try decode(Result.self, data).limits
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        func entry(_ key: String) -> ListeningLimits.Entry? {
            items.first { $0.key == key }.map { item in
                ListeningLimits.Entry(
                    limit: item.limit,
                    used: item.used,
                    resetsAt: item.resetsAt.flatMap { formatter.date(from: $0) ?? ISO8601DateFormatter().date(from: $0) }
                )
            }
        }
        return ListeningLimits(audio: entry(ListeningLimits.audioKey), battery: entry(ListeningLimits.batteryKey))
    }

    public func reportListeningBattery(usedPercent: Int) async throws {
        let body = try JSONSerialization.data(withJSONObject: [ListeningLimits.batteryKey: min(max(usedPercent, 0), 100)])
        _ = try await http.send(DeviceRequest(method: "POST", path: "usage/report", body: body))
    }
}
