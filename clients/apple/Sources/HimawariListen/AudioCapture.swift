#if os(iOS)
@preconcurrency import AVFoundation
import Foundation
import HimawariCore

struct CapturedBuffer: @unchecked Sendable {
    let buffer: AVAudioPCMBuffer
    let hostTime: Date
}

enum CaptureEvent: Sendable {
    case interruptionBegan
    case interruptionEnded(shouldResume: Bool)
    case routeChanged(AudioInputRoute)
    case mediaServicesReset
}

final class AudioCapture: @unchecked Sendable {
    private let engine = AVAudioEngine()
    private let session = AVAudioSession.sharedInstance()
    private let lock = NSLock()
    private var bufferContinuation: AsyncStream<CapturedBuffer>.Continuation?
    private var eventContinuation: AsyncStream<CaptureEvent>.Continuation?
    private var observers: [NSObjectProtocol] = []
    private var loudness: Double = -160

    let buffers: AsyncStream<CapturedBuffer>
    let events: AsyncStream<CaptureEvent>

    init() {
        var bufferContinuation: AsyncStream<CapturedBuffer>.Continuation?
        buffers = AsyncStream(bufferingPolicy: .bufferingNewest(64)) { bufferContinuation = $0 }
        var eventContinuation: AsyncStream<CaptureEvent>.Continuation?
        events = AsyncStream(bufferingPolicy: .bufferingNewest(16)) { eventContinuation = $0 }
        self.bufferContinuation = bufferContinuation
        self.eventContinuation = eventContinuation
        observe()
    }

    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
    }

    var inputFormat: AVAudioFormat {
        engine.inputNode.outputFormat(forBus: 0)
    }

    var currentRoute: AudioInputRoute {
        Self.route(of: session.currentRoute)
    }

    var recentLoudnessDBFS: Double {
        lock.withLock { loudness }
    }

    func configureSession() throws {
        try session.setCategory(.playAndRecord, mode: .default, options: [.allowBluetoothHFP, .bluetoothHighQualityRecording, .defaultToSpeaker, .mixWithOthers])
        try session.setActive(true, options: [])
    }

    func start() throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            self?.receive(buffer)
        }
        engine.prepare()
        try engine.start()
    }

    func stop(deactivate: Bool) {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        if deactivate {
            try? session.setActive(false, options: [.notifyOthersOnDeactivation])
        }
    }

    func restart() throws {
        try session.setActive(true, options: [])
        if !engine.isRunning {
            try start()
        }
    }

    private func receive(_ buffer: AVAudioPCMBuffer) {
        if let level = Self.dbfs(buffer) {
            lock.withLock { loudness = level }
        }
        bufferContinuation?.yield(CapturedBuffer(buffer: buffer, hostTime: Date()))
    }

    private func observe() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: nil) { [weak self] note in
            guard
                let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                let type = AVAudioSession.InterruptionType(rawValue: raw)
            else { return }
            switch type {
            case .began:
                self?.eventContinuation?.yield(.interruptionBegan)
            case .ended:
                let options = (note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt).map(AVAudioSession.InterruptionOptions.init(rawValue:)) ?? []
                self?.eventContinuation?.yield(.interruptionEnded(shouldResume: options.contains(.shouldResume)))
            @unknown default:
                break
            }
        })
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: nil) { [weak self] _ in
            guard let self else { return }
            eventContinuation?.yield(.routeChanged(currentRoute))
        })
        observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: nil) { [weak self] _ in
            self?.eventContinuation?.yield(.mediaServicesReset)
        })
    }

    static func route(of route: AVAudioSessionRouteDescription) -> AudioInputRoute {
        guard let input = route.inputs.first else { return .deviceMicrophone }
        switch input.portType {
        case .bluetoothHFP, .bluetoothLE:
            return .airpods
        case .builtInMic:
            return .deviceMicrophone
        default:
            return .wearableMicrophone
        }
    }

    static func dbfs(_ buffer: AVAudioPCMBuffer) -> Double? {
        guard let channel = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return nil }
        let count = Int(buffer.frameLength)
        var sum: Float = 0
        for index in 0..<count { sum += channel[index] * channel[index] }
        let rms = (sum / Float(count)).squareRoot()
        guard rms > 0 else { return -160 }
        return Double(20 * log10(rms))
    }
}

final class SpeakerAudioWindow: @unchecked Sendable {
    static let sampleRate: Double = 16_000

    private let lock = NSLock()
    private var samples: [Float] = []
    private var firstSampleTime: TimeInterval = 0
    private let capacity: Int
    private var converter: AVAudioConverter?
    private let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: SpeakerAudioWindow.sampleRate, channels: 1, interleaved: false)

    init(seconds: Double) {
        capacity = Int(seconds * Self.sampleRate)
    }

    func reset(at time: TimeInterval) {
        lock.withLock {
            samples.removeAll(keepingCapacity: true)
            firstSampleTime = time
        }
    }

    func append(_ buffer: AVAudioPCMBuffer) {
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

    func slice(from start: TimeInterval, to end: TimeInterval) -> [Float] {
        lock.withLock {
            let lower = max(0, Int(((start - firstSampleTime) * Self.sampleRate).rounded(.down)))
            let upper = min(samples.count, Int(((end - firstSampleTime) * Self.sampleRate).rounded(.up)))
            guard upper > lower else { return [] }
            return Array(samples[lower..<upper])
        }
    }
}
#endif
