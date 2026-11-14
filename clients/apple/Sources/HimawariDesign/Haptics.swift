import Foundation
import HimawariCore
import SwiftUI
#if canImport(CoreHaptics)
import CoreHaptics
#endif
#if canImport(UIKit)
import UIKit
#endif
#if os(watchOS)
import WatchKit
#endif

@MainActor
public final class Haptics {
    public static let shared = Haptics()

    private static let settingsKey = "himawari.haptics.settings"
    private var policy: HapticPolicy
    #if canImport(CoreHaptics) && os(iOS)
    private var engine: CHHapticEngine?
    #endif

    private init() {
        let stored = UserDefaults.standard.data(forKey: Self.settingsKey)
            .flatMap { try? JSONDecoder().decode(HapticSettings.self, from: $0) }
        policy = HapticPolicy(settings: stored ?? HapticSettings())
    }

    public var settings: HapticSettings {
        policy.settings
    }

    public func update(_ settings: HapticSettings) {
        policy.update(settings)
        if let data = try? JSONEncoder().encode(settings) {
            UserDefaults.standard.set(data, forKey: Self.settingsKey)
        }
    }

    public func report(_ event: HapticEvent, ownerViewingThisPage: Bool = false, waitedSeconds: TimeInterval = 0, recording: Bool = false) {
        let situation = HapticSituation(
            level: policy.settings.level,
            systemHapticsEnabled: Self.hardwareSupportsHaptics,
            recording: recording,
            ownerViewingThisPage: ownerViewingThisPage,
            waitedSeconds: waitedSeconds
        )
        guard let pattern = policy.decide(event, in: situation, at: Date()) else { return }
        play(pattern)
    }

    public func preview(_ event: HapticEvent) {
        play(event.pattern)
    }

    private static var hardwareSupportsHaptics: Bool {
        #if canImport(CoreHaptics) && os(iOS)
        CHHapticEngine.capabilitiesForHardware().supportsHaptics
        #else
        false
        #endif
    }

    private func play(_ pattern: HapticPattern) {
        #if canImport(UIKit) && os(iOS)
        switch pattern {
        case .impactLight: UIImpactFeedbackGenerator(style: .light).impactOccurred()
        case .impactMedium: UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        case .impactSoft: UIImpactFeedbackGenerator(style: .soft).impactOccurred()
        case .impactRigid: UIImpactFeedbackGenerator(style: .rigid).impactOccurred()
        case .success: UINotificationFeedbackGenerator().notificationOccurred(.success)
        case .error: UINotificationFeedbackGenerator().notificationOccurred(.error)
        case .warning: UINotificationFeedbackGenerator().notificationOccurred(.warning)
        case .bloom: playFile("bloom")
        case .knock: playFile("knock")
        case .knockFirm: playFile("knock-firm")
        }
        #elseif os(watchOS)
        let device = WKInterfaceDevice.current()
        switch pattern {
        case .impactLight, .impactMedium, .impactSoft, .impactRigid: device.play(.click)
        case .success: device.play(.success)
        case .error: device.play(.failure)
        case .warning: device.play(.retry)
        case .bloom, .knock, .knockFirm: device.play(.notification)
        }
        #endif
    }

    #if canImport(CoreHaptics) && os(iOS)
    private func playFile(_ name: String) {
        guard Self.hardwareSupportsHaptics, let url = Bundle.module.url(forResource: name, withExtension: "ahap") else { return }
        do {
            if engine == nil {
                let created = try CHHapticEngine()
                created.isAutoShutdownEnabled = true
                created.resetHandler = { [weak created] in try? created?.start() }
                engine = created
            }
            try engine?.start()
            try engine?.playPattern(from: url)
        } catch {
            engine = nil
        }
    }
    #endif
}
