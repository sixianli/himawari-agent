#if os(iOS) || os(macOS)
@preconcurrency import AVFoundation
import Foundation

package final class SpeakerAudioWindow: @unchecked Sendable {
    package static let sampleRate = FluidSpeakerEmbedder.sampleRate

    private let lock = NSLock()
    private var samples: [Float] = []
    private var firstSampleTime: TimeInterval = 0
    private let capacity: Int
    private var converter: AVAudioConverter?
    private let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: SpeakerAudioWindow.sampleRate, channels: 1, interleaved: false)

    package init(seconds: Double) {
        capacity = Int(seconds * Self.sampleRate)
    }

    package func reset(at time: TimeInterval) {
        lock.withLock {
            samples.removeAll(keepingCapacity: true)
            firstSampleTime = time
        }
    }

    package func append(_ buffer: AVAudioPCMBuffer) {
        guard let target else { return }
        if converter == nil || converter?.inputFormat != buffer.format {
            converter = AVAudioConverter(from: buffer.format, to: target)
        }
        guard let converter else { return }
        let ratio = target.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 32)
        guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
        nonisolated(unsafe) var supplied = false
        var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            if supplied {
                status.pointee = .noDataNow
                return nil
            }
            supplied = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, let channel = output.floatChannelData?[0] else { return }
        let fresh = Array(UnsafeBufferPointer(start: channel, count: Int(output.frameLength)))
        lock.withLock {
            samples.append(contentsOf: fresh)
            let overflow = samples.count - self.capacity
            if overflow > 0 {
                samples.removeFirst(overflow)
                firstSampleTime += Double(overflow) / Self.sampleRate
            }
        }
    }

    package func slice(from start: TimeInterval, to end: TimeInterval) -> [Float] {
        lock.withLock {
            let lower = max(0, Int(((start - firstSampleTime) * Self.sampleRate).rounded(.down)))
            let upper = min(samples.count, Int(((end - firstSampleTime) * Self.sampleRate).rounded(.up)))
            guard upper > lower else { return [] }
            return Array(samples[lower..<upper])
        }
    }
}
#endif
