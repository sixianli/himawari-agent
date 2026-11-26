import HimawariCore
import HimawariDesign
import HimawariListenUI
import SwiftUI

public struct ListenEntrySheet: View {
    private let controller: ListeningController
    private let dismiss: () -> Void

    public init(controller: ListeningController, dismiss: @escaping () -> Void) {
        self.controller = controller
        self.dismiss = dismiss
    }

    public var body: some View {
        Group {
            if case let .recording(progress) = controller.enrollment {
                VoiceprintEnrollView(progress: progress, onClose: close, onLater: close)
            } else {
                ListenIntroView(onStart: start, onLater: dismiss)
            }
        }
        .onChange(of: controller.hasVoiceprint) { _, has in
            if has { dismiss() }
        }
    }

    private func start() {
        Task {
            await controller.start()
            guard controller.isListening else { return }
            if controller.hasVoiceprint {
                dismiss()
            } else {
                controller.beginEnrollment()
            }
        }
    }

    private func close() {
        controller.skipEnrollment()
        dismiss()
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
            .background(Color.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 30, style: .continuous))
            .padding(.horizontal, 12)
            .padding(.bottom, 34)
            .environment(\.colorScheme, .dark)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }
}
