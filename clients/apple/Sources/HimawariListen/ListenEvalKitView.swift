#if os(iOS)
import HimawariCore
import HimawariListenEngine
import HimawariDesign
import HimawariListenUI
import SwiftUI

enum EvalText {
    static func text(_ key: String) -> String {
        Bundle.module.localizedString(forKey: key, value: nil, table: nil)
    }

    static func format(_ key: String, _ arguments: CVarArg...) -> String {
        String(format: text(key), locale: Locale.current, arguments: arguments)
    }
}

public struct ListenEvalKitView: View {
    @State private var recorder: ListenEvalRecorder?
    @State private var loadProblem: String?
    private let close: () -> Void

    public init(close: @escaping () -> Void) {
        self.close = close
    }

    public var body: some View {
        VStack(spacing: 0) {
            header
            if let recorder {
                ListenEvalKitContent(recorder: recorder)
            } else if let loadProblem {
                Text(loadProblem)
                    .foregroundStyle(Color.hmMuted)
                    .padding(24)
                Spacer()
            } else {
                Spacer()
            }
        }
        .background(Color.hmBackground.ignoresSafeArea())
        .task {
            guard recorder == nil else { return }
            do {
                recorder = ListenEvalRecorder(kit: try ListenResources.evalKit())
            } catch {
                loadProblem = error.localizedDescription
            }
        }
    }

    private var header: some View {
        HStack {
            Button {
                Task {
                    await recorder?.stop()
                    close()
                }
            } label: {
                Icon(.x, size: 18)
                    .foregroundStyle(Color.hmText)
                    .frame(width: 48, height: 48)
                    .background(Color.hmFill, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(EvalText.text("eval.close")))
            Spacer()
            Text(EvalText.text("eval.title"))
                .font(.system(size: 18, weight: .bold))
                .foregroundStyle(Color.hmText)
            Spacer()
            Color.clear.frame(width: 48, height: 48)
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
    }
}

struct ListenEvalKitContent: View {
    let recorder: ListenEvalRecorder

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text(EvalText.format("eval.progress", recorder.recordedCount, recorder.kit.promptCount))
                    .font(.system(size: 15))
                    .foregroundStyle(Color.hmMuted)
                if let stage = recorder.currentStage, let prompt = recorder.currentPrompt {
                    stageCard(stage)
                    promptCard(prompt)
                    routeLine
                    controls
                } else {
                    Text(EvalText.text("eval.allDone"))
                        .font(.system(size: 22, weight: .semibold))
                        .foregroundStyle(Color.hmText)
                }
                if case let .failed(message) = recorder.phase {
                    Text(message)
                        .font(.system(size: 15))
                        .foregroundStyle(Color.hmDanger)
                        .onTapGesture { recorder.clearFailure() }
                }
                Text(EvalText.text("eval.export"))
                    .font(.system(size: 15))
                    .foregroundStyle(Color.hmMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(20)
        }
        .onAppear { recorder.refreshRoute() }
    }

    private func stageCard(_ stage: ListenEvalStage) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(EvalText.text("eval.purpose.\(stage.purpose.rawValue)"))
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Color.hmText)
                Spacer()
                Text(EvalText.format("eval.stageProgress", recorder.session.recordedCount(in: stage), stage.prompts.count))
                    .font(.system(size: 15).monospacedDigit())
                    .foregroundStyle(Color.hmMuted)
            }
            Text(stage.setup)
                .font(.system(size: 15))
                .foregroundStyle(Color.hmMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .himawariCard(padding: EdgeInsets(top: 16, leading: 16, bottom: 16, trailing: 16))
    }

    private func promptCard(_ prompt: ListenEvalPrompt) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(prompt.text)
                .font(.system(size: 26, weight: .semibold))
                .foregroundStyle(Color.hmText)
                .fixedSize(horizontal: false, vertical: true)
            if recorder.session.recording(for: prompt.id) != nil {
                Text(EvalText.text("eval.recorded"))
                    .font(.system(size: 13))
                    .foregroundStyle(Color.hmMuted)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 160, alignment: .topLeading)
    }

    private var routeLine: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(EvalText.format("eval.routeNow", ListenText.source(recorder.route)))
                .font(.system(size: 15))
                .foregroundStyle(Color.hmMuted)
            if recorder.routeMismatch {
                Text(EvalText.text(recorder.currentStage?.placement == .airpods ? "eval.routeMismatch.airpods" : "eval.routeMismatch.other"))
                    .font(.system(size: 15))
                    .foregroundStyle(Color.hmDanger)
            }
        }
    }

    private var controls: some View {
        VStack(spacing: 16) {
            Button {
                if recorder.isRecording {
                    Task { await recorder.stop() }
                } else {
                    recorder.start()
                }
            } label: {
                ZStack {
                    Circle()
                        .fill(recorder.isRecording ? Color.hmDanger : Color.hmSun)
                        .frame(width: 96, height: 96)
                        .scaleEffect(1 + recorder.level * 0.15)
                    Text(EvalText.text(recorder.isRecording ? "eval.stop" : "eval.record"))
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Color.white)
                }
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity)
            HStack {
                Button(EvalText.text("eval.previous")) { recorder.previous() }
                Spacer()
                Button(EvalText.text("eval.skip")) { recorder.skip() }
            }
            .font(.system(size: 17))
            .foregroundStyle(Color.hmSun)
            .disabled(recorder.isRecording)
        }
    }
}
#endif
