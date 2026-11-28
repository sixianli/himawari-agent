import HimawariCore
import HimawariDesign
import HimawariListenUI
import SwiftUI
#if os(iOS)
import UIKit
#endif

public struct ListenEntrySheet: View {
    private let controller: ListeningController
    private let dismiss: () -> Void
    @State private var started = false

    public init(controller: ListeningController, dismiss: @escaping () -> Void) {
        self.controller = controller
        self.dismiss = dismiss
    }

    public var body: some View {
        Group {
            if started {
                VoiceprintEnrollScreen(controller: controller, dismiss: dismiss)
            } else {
                ListenIntroView(onStart: start, onLater: dismiss)
            }
        }
    }

    private func start() {
        Task {
            await controller.start()
            guard controller.isListening else { return }
            if controller.hasVoiceprint {
                dismiss()
            } else {
                started = true
            }
        }
    }
}

public struct VoiceprintEnrollScreen: View {
    private let controller: ListeningController
    private let dismiss: () -> Void
    @Environment(\.openURL) private var openURL

    public init(controller: ListeningController, dismiss: @escaping () -> Void) {
        self.controller = controller
        self.dismiss = dismiss
    }

    public var body: some View {
        Group {
            switch controller.enrollment {
            case let .recording(progress):
                VoiceprintEnrollView(progress: progress, onClose: close, onLater: close)
            case let .failed(failure):
                VoiceprintEnrollStatusView(status: .failed(failure), onClose: close, onRetry: begin, onOpenSettings: openSettings)
            case .preparing, .idle:
                VoiceprintEnrollStatusView(status: .preparing, onClose: close, onRetry: begin, onOpenSettings: openSettings)
            }
        }
        .task {
            if controller.enrollment == .idle, !controller.hasVoiceprint {
                await controller.beginEnrollment()
            }
        }
        .onChange(of: controller.hasVoiceprint) { _, has in
            if has { dismiss() }
        }
        .onDisappear { controller.skipEnrollment() }
    }

    private func begin() {
        Task { await controller.beginEnrollment() }
    }

    private func close() {
        controller.skipEnrollment()
        dismiss()
    }

    private func openSettings() {
        #if os(iOS)
        if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
        #endif
    }
}

public struct ListenOverlay: View {
    private let controller: ListeningController

    public init(controller: ListeningController) {
        self.controller = controller
    }

    public var body: some View {
        if let live = controller.live, live.phase == .calling || live.phase == .asking {
            Group {
                if live.phase == .calling {
                    ListenCallPanel(state: live, levels: controller.levels)
                } else {
                    ListenAskPanel(state: live) { label in
                        Button { controller.notMe() } label: { label }.buttonStyle(.pressable)
                    } itsMe: { label in
                        Button { Task { await controller.itsMe() } } label: { label }.buttonStyle(.pressable)
                    }
                }
            }
            .hmRaised(RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous), fill: Color.hmSurface, shadow: DesignTokens.Shadows.liftBig)
            .environment(\.colorScheme, .dark)
            .padding(.horizontal, 12)
            .padding(.bottom, 34)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }
}
