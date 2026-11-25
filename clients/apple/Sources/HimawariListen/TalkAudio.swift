#if os(iOS)
@preconcurrency import AVFoundation
import Foundation

final class TalkAudio: @unchecked Sendable {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let session = AVAudioSession.sharedInstance()
    private var continuation: AsyncStream<CapturedBuffer>.Continuation?
    private var playFormat: AVAudioFormat?
    private var converters: [AVAudioFormat: AVAudioConverter] = [:]

    let buffers: AsyncStream<CapturedBuffer>

    init() {
        var continuation: AsyncStream<CapturedBuffer>.Continuation?
        buffers = AsyncStream(bufferingPolicy: .bufferingNewest(64)) { continuation = $0 }
        self.continuation = continuation
    }

    func start() throws {
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP, .defaultToSpeaker])
        try session.setActive(true, options: [])
        let input = engine.inputNode
        try input.setVoiceProcessingEnabled(true)
        let output = AVAudioFormat(standardFormatWithSampleRate: engine.outputNode.outputFormat(forBus: 0).sampleRate, channels: 1)
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: output)
        playFormat = output
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 4096, format: input.outputFormat(forBus: 0)) { [weak self] buffer, _ in
            self?.continuation?.yield(CapturedBuffer(buffer: buffer, hostTime: Date()))
        }
        engine.prepare()
        try engine.start()
        player.play()
    }

    func play(_ buffer: AVAudioPCMBuffer, played: @escaping @Sendable () -> Void) {
        guard let playFormat, let converted = convert(buffer, to: playFormat) else {
            played()
            return
        }
        player.scheduleBuffer(converted, completionCallbackType: .dataPlayedBack) { _ in played() }
    }

    func silence() {
        player.stop()
        player.play()
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        player.stop()
        engine.stop()
        try? engine.inputNode.setVoiceProcessingEnabled(false)
        try? session.setActive(false, options: [.notifyOthersOnDeactivation])
        continuation?.finish()
    }

    private func convert(_ buffer: AVAudioPCMBuffer, to format: AVAudioFormat) -> AVAudioPCMBuffer? {
        if buffer.format == format { return buffer }
        let converter = converters[buffer.format] ?? AVAudioConverter(from: buffer.format, to: format)
        guard let converter else { return nil }
        converters[buffer.format] = converter
        let ratio = format.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up))
        guard capacity > 0, let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
        var supplied = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, outStatus in
            if supplied {
                outStatus.pointee = .noDataNow
                return nil
            }
            supplied = true
            outStatus.pointee = .haveData
            return buffer
        }
        return status == .error ? nil : output
    }
}
#endif
