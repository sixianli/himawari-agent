#if os(iOS)
import AVFoundation
import Foundation
import HimawariCore
import Network
import UIKit

public struct DeviceStatusPermission: DevicePermission {
    public var id: String { "device_status" }
    public var name: LocalizedLine { line("设备状态", "Device status", "端末の状態") }
    public var settingsPath: LocalizedLine { SettingsPath.app }
    public var shownToOwner: Bool { false }
    public var purpose: LocalizedLine {
        line("你问手机还有多少电、连着什么网、耳机连上没有时，Himawari 读这台 iPhone 此刻的状态。",
             "When you ask about battery, network or headphones, Himawari reads this iPhone's current status.",
             "電池・通信・イヤホンについて聞くと、この iPhone の今の状態を読みます。")
    }

    public func status() async -> DevicePermissionStatus { .authorized }
    public func request() async -> DevicePermissionStatus { .authorized }
}

struct DeviceStatusReading: Sendable {
    let batteryPercent: Int?
    let charging: Bool?
    let lowPowerMode: Bool
    let outputs: [JSONObject]
}

public final class DeviceStatusActions: DeviceActionHandler, @unchecked Sendable {
    public let names = ["device.status"]
    public let readOnly: Set<String> = ["device.status"]
    public let permission: DevicePermission = DeviceStatusPermission()
    static let networkLimit: Duration = .seconds(3)

    public init() {}

    public func snapshot(_ delivery: DeviceActionDelivery) async throws -> JSONObject? { [:] }

    public func perform(_ delivery: DeviceActionDelivery) async throws -> JSONObject {
        let reading = await Self.read()
        var result: JSONObject = ["lowPowerMode": .bool(reading.lowPowerMode)]
        if let percent = reading.batteryPercent { result["batteryPercent"] = .number(Double(percent)) }
        if let charging = reading.charging { result["charging"] = .bool(charging) }
        if let network = await Self.network() { result["network"] = .string(network) }
        result["audioOutputs"] = .array(reading.outputs.map(DeviceActionValue.object))
        return result
    }

    @MainActor
    static func read() -> DeviceStatusReading {
        let device = UIDevice.current
        let monitoring = device.isBatteryMonitoringEnabled
        device.isBatteryMonitoringEnabled = true
        defer { device.isBatteryMonitoringEnabled = monitoring }
        let level = device.batteryLevel
        let state = device.batteryState
        let outputs = AVAudioSession.sharedInstance().currentRoute.outputs.map { port -> JSONObject in
            ["kind": .string(Self.kind(port.portType)), "name": .string(port.portName)]
        }
        return DeviceStatusReading(
            batteryPercent: level < 0 ? nil : Int((level * 100).rounded()),
            charging: state == .unknown ? nil : (state == .charging || state == .full),
            lowPowerMode: ProcessInfo.processInfo.isLowPowerModeEnabled,
            outputs: outputs
        )
    }

    static func kind(_ port: AVAudioSession.Port) -> String {
        switch port {
        case .builtInSpeaker, .builtInReceiver: "speaker"
        case .headphones, .usbAudio: "wired_headphones"
        case .bluetoothA2DP, .bluetoothLE, .bluetoothHFP: "bluetooth"
        case .carAudio: "carplay"
        case .airPlay: "airplay"
        case .HDMI, .lineOut: "wired"
        default: "other"
        }
    }

    static func network() async -> String? {
        let monitor = NWPathMonitor()
        let queue = DispatchQueue(label: "himawari.device-status.network")
        let answer = NetworkAnswer()
        return await withCheckedContinuation { continuation in
            answer.set(continuation)
            monitor.pathUpdateHandler = { path in
                answer.resume(Self.network(path))
                monitor.cancel()
            }
            monitor.start(queue: queue)
            Task {
                try? await Task.sleep(for: Self.networkLimit)
                answer.resume(nil)
                monitor.cancel()
            }
        }
    }

    static func network(_ path: NWPath) -> String {
        guard path.status == .satisfied else { return "none" }
        if path.usesInterfaceType(.wifi) { return "wifi" }
        if path.usesInterfaceType(.cellular) { return "cellular" }
        if path.usesInterfaceType(.wiredEthernet) { return "wired" }
        return "other"
    }

    public func readBack(_ delivery: DeviceActionDelivery, made: JSONObject?) async throws -> DeviceActionReading {
        .unreadable
    }
}

final class NetworkAnswer: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<String?, Never>?

    func set(_ continuation: CheckedContinuation<String?, Never>) {
        lock.lock()
        self.continuation = continuation
        lock.unlock()
    }

    func resume(_ value: String?) {
        lock.lock()
        let waiting = continuation
        continuation = nil
        lock.unlock()
        waiting?.resume(returning: value)
    }
}
#endif
