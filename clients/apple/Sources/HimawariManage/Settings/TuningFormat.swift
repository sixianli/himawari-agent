import Foundation

enum TuningValueKind: String, Sendable {
    case ratio
    case duration
    case count
}

enum TuningStorageUnit: String, Sendable {
    case permille
    case ms
    case s
    case min
    case h
    case d
    case count

    var seconds: Double? {
        switch self {
        case .ms: 0.001
        case .s: 1
        case .min: 60
        case .h: 3600
        case .d: 86_400
        case .permille, .count: nil
        }
    }
}

extension TuningItem {
    func text(_ raw: Int) -> String {
        switch (kind, storageUnit) {
        case (.ratio, .permille?):
            return raw % 10 == 0 ? "\(raw / 10)%" : String(format: "%.1f%%", Double(raw) / 10)
        case (.duration, let unit?):
            if let seconds = unit.seconds, let text = Self.durationText(seconds: Double(raw) * seconds) { return text }
            return plain(raw)
        default:
            return plain(raw)
        }
    }

    private func plain(_ raw: Int) -> String {
        "\(raw)" + (unit.isEmpty ? "" : " \(unit)")
    }

    func stepUp(from raw: Int) -> Int {
        let size = stepSize(at: raw)
        return min(maximum, (raw / size + 1) * size)
    }

    func stepDown(from raw: Int) -> Int {
        let size = stepSize(at: raw - 1)
        return max(minimum, ((raw + size - 1) / size - 1) * size)
    }

    private func stepSize(at raw: Int) -> Int {
        switch (kind, storageUnit) {
        case (.ratio, _):
            return 50
        case (.duration, let unit?):
            guard let perUnit = unit.seconds else { return step }
            let seconds = Double(max(raw, 0)) * perUnit
            let tier: Double = seconds < 1 ? 0.1 : seconds < 60 ? 1 : seconds < 3600 ? 60 : seconds < 86_400 ? 3600 : 86_400
            return max(1, Int((tier / perUnit).rounded()))
        default:
            return step
        }
    }

    private static func durationText(seconds: Double) -> String? {
        guard seconds >= 1, seconds.rounded() == seconds else { return nil }
        let formatter = DateComponentsFormatter()
        formatter.allowedUnits = [.day, .hour, .minute, .second]
        formatter.unitsStyle = .full
        formatter.maximumUnitCount = 2
        formatter.zeroFormattingBehavior = .dropAll
        var calendar = Calendar(identifier: .gregorian)
        calendar.locale = Locale(identifier: ManageLanguage.current.serverTag)
        formatter.calendar = calendar
        guard let text = formatter.string(from: seconds) else { return nil }
        return ManageLanguage.current == .zh ? spacedChinese(text) : text
    }

    static func spacedChinese(_ text: String) -> String {
        var result = ""
        var previous: Character?
        for character in text.replacingOccurrences(of: "秒钟", with: "秒") {
            if let before = previous, before != " ", character != " ", before.isASCII != character.isASCII, before.isNumber || character.isNumber {
                result.append(" ")
            }
            result.append(character)
            previous = character
        }
        return result
    }
}
