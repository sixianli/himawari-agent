import Foundation

public enum SpeechLevel {
    public static let frameSeconds = 0.1
    public static let percentile = 0.9
    public static let silence = -160.0

    public static func dbfs(samples: [Float], sampleRate: Double) -> Double? {
        guard !samples.isEmpty, sampleRate > 0 else { return nil }
        let frame = max(1, Int(sampleRate * frameSeconds))
        var levels: [Double] = []
        levels.reserveCapacity(samples.count / frame + 1)
        var start = 0
        while start < samples.count {
            let end = min(samples.count, start + frame)
            levels.append(level(samples[start..<end]))
            start = end
        }
        levels.sort()
        let index = Int((Double(levels.count - 1) * percentile).rounded(.down))
        return levels[index]
    }

    static func level(_ frame: ArraySlice<Float>) -> Double {
        var sum: Double = 0
        for value in frame { sum += Double(value) * Double(value) }
        let rms = (sum / Double(frame.count)).squareRoot()
        guard rms > 0 else { return silence }
        return max(silence, 20 * log10(rms))
    }
}
