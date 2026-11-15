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
    private var bufferContinuation: AsyncStream<CapturedBuffer>.Continuation?
    private var eventContinuation: AsyncStream<CaptureEvent>.Continuation?
    private var observers: [NSObjectProtocol] = []

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

    var playsThroughSameHeadset: Bool {
        Self.playsThroughSameHeadset(session.currentRoute)
    }

    static func playsThroughSameHeadset(_ route: AVAudioSessionRouteDescription) -> Bool {
        HeadphoneWear.playsThroughSameHeadset(input: route.inputs.first.map(snapshot), outputs: route.outputs.map(snapshot))
    }

    static func snapshot(_ port: AVAudioSessionPortDescription) -> AudioPortSnapshot {
        let bluetooth: Set<AVAudioSession.Port> = [.bluetoothHFP, .bluetoothA2DP, .bluetoothLE]
        return AudioPortSnapshot(bluetooth: bluetooth.contains(port.portType), uid: port.uid, name: port.portName)
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
#endif
