import HimawariCore
import HimawariDesign
import SwiftUI

public struct ProcessRowView: View {
    let line: ProcessLine
    let failed: Bool
    @State private var showingSteps = false
    @Environment(\.processStepsOpenAfter) private var openAfter

    public init(line: ProcessLine, failed: Bool) {
        self.line = line
        self.failed = failed
    }

    public var body: some View {
        content
            .onChange(of: line) { old, new in
                Self.reportHaptic(from: old, to: new, failed: failed)
            }
            .task {
                guard let openAfter else { return }
                try? await Task.sleep(for: .seconds(openAfter))
                showingSteps = true
            }
    }

    static func reportHaptic(from old: ProcessLine, to new: ProcessLine, failed: Bool) {
        switch (old, new) {
        case (.waiting, .waiting):
            break
        case (_, .waiting):
            Haptics.shared.report(.approvalNeeded, ownerViewingThisPage: true)
        case (.finished, .finished), (.stopped, .stopped), (.failed, .failed):
            break
        case let (_, .finished(_, seconds)):
            Haptics.shared.report(failed ? .taskFailed : .longTaskFinished, ownerViewingThisPage: true, waitedSeconds: TimeInterval(seconds))
        case let (_, .failed(_, seconds, _)):
            Haptics.shared.report(.taskFailed, ownerViewingThisPage: true, waitedSeconds: TimeInterval(seconds))
        default:
            break
        }
    }

    @ViewBuilder
    private var content: some View {
        switch line {
        case .thinking:
            ProcessLineLabel(icon: .bulb, text: L.text("process.thinking"), tint: .hmMuted, shimmering: true)
        case let .working(current, setback):
            VStack(alignment: .leading, spacing: 12) {
                if let setback {
                    ProcessLineLabel(icon: .alertCircle, text: setback.title, tint: .hmMuted, shimmering: false)
                }
                if current.phase == .failed || current.phase == .unavailable {
                    ProcessLineLabel(icon: .alertCircle, text: current.title, tint: .hmMuted, shimmering: false)
                } else if current.phase == .unrecognized {
                    ProcessLineLabel(icon: .puzzle, text: current.title, tint: .hmMuted, shimmering: false)
                } else {
                    ProcessLineLabel(icon: Self.icon(current.icon), text: current.title, tint: .hmMuted, shimmering: true)
                }
            }
            .animation(.easeInOut(duration: 0.25), value: current.id)
        case let .waiting(step):
            ProcessLineLabel(icon: .handStop, text: step.title.isEmpty ? L.text("process.waiting") : step.title, tint: .hmSun, shimmering: false)
        case let .finished(steps, _):
            summary(icon: .check, text: L.format("process.didThings", steps.count), steps: steps)
        case let .stopped(steps, _):
            summary(icon: .stop, text: L.text("process.stopped"), steps: steps)
        case let .failed(steps, _, failure):
            summary(icon: .alertCircle, text: Self.failedText(failure), steps: steps)
        }
    }

    private func summary(icon: IconName, text: String, steps: [ProcessStep]) -> some View {
        Button {
            showingSteps = true
        } label: {
            HStack(spacing: DesignTokens.ProcessRow.gap) {
                Icon(icon, size: DesignTokens.IconSize.processRow)
                Text(text)
                    .hmType(ProcessRowText.type)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if !steps.isEmpty {
                    Icon(.chevronRight, size: DesignTokens.IconSize.chevron)
                }
            }
            .foregroundStyle(Color.hmMuted)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .disabled(steps.isEmpty)
        .accessibilityHint(Text(L.text("process.expand")))
        .sheet(isPresented: $showingSteps) {
            ProcessStepsSheet(steps: steps) { showingSteps = false }
                .onAppear { Haptics.shared.report(.sheetSettled) }
                .presentationDetents([.medium, .large])
                .presentationCornerRadius(DesignTokens.Radius.sheetTop)
                .presentationBackground(Color.hmBackground)
        }
    }

    static let failureCodes: Set<String> = [
        "PI_MODEL_RATE_LIMITED", "PI_MODEL_AUTH_FAILED", "PI_MODEL_UNAVAILABLE", "PI_MODEL_QUOTA_EXCEEDED",
        "PI_CONTEXT_WINDOW_EXHAUSTED", "PI_MODEL_ERROR", "PI_TOOL_LOOP_DETECTED", "PI_FINAL_ANSWER_EMPTY",
        "PI_FINAL_ANSWER_INCOMPLETE",
    ]

    static func failedText(_ failure: RunFailure?) -> String {
        guard let failure else { return L.text("process.failed") }
        let code = failureCodes.contains(failure.code) ? failure.code : "OTHER"
        let reason = L.text("process.failure.\(code)")
        return L.format(failure.retried ? "process.failedRetried" : "process.failedBecause", reason)
    }

    static func icon(_ icon: ProcessIcon) -> IconName {
        IconName(rawValue: icon.rawValue) ?? .puzzle
    }
}

struct ProcessStepsSheet: View {
    let steps: [ProcessStep]
    let close: () -> Void

    var body: some View {
        VStack(spacing: 24) {
            ZStack {
                Text(L.text("process.sheet.title"))
                    .hmType(DesignTokens.TypeScale.sheetTitle)
                    .foregroundStyle(Color.hmText)
                HStack {
                    Button(action: close) {
                        Icon(.x, size: DesignTokens.IconSize.glassButton)
                            .foregroundStyle(Color.hmText)
                            .frame(width: DesignTokens.Size.glassButton, height: DesignTokens.Size.glassButton)
                            .background(Color.hmFill, in: Circle())
                    }
                    .buttonStyle(.pressable)
                    .accessibilityLabel(Text(L.text("process.sheet.close")))
                    Spacer()
                }
            }
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(Array(steps.enumerated()), id: \.element.id) { index, step in
                        HStack(spacing: DesignTokens.Size.rowGap) {
                            Icon(
                                step.phase == .failed || step.phase == .unavailable ? .alertCircle : step.phase == .unrecognized ? .puzzle : ProcessRowView.icon(step.icon),
                                size: DesignTokens.IconSize.listRow
                            )
                            .foregroundStyle(Color.hmText)
                            Text(step.title)
                                .hmType(DesignTokens.TypeScale.body)
                                .foregroundStyle(Color.hmText)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(.vertical, 11)
                        .frame(minHeight: DesignTokens.Size.rowMinHeight)
                        .overlay(alignment: .bottom) {
                            if index < steps.count - 1 { RowSeparator() }
                        }
                    }
                }
                .padding(.horizontal, DesignTokens.Size.cardPaddingX)
                .hmRaised(RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous), fill: Color.hmSurface, shadow: DesignTokens.Shadows.lift)
            }
            .scrollIndicators(.hidden)
        }
        .padding(EdgeInsets(top: DesignTokens.Size.sheetPaddingTop, leading: DesignTokens.Size.sheetPaddingHorizontal, bottom: 0, trailing: DesignTokens.Size.sheetPaddingHorizontal))
    }
}

struct ProcessLineLabel: View {
    let icon: IconName
    let text: String
    let tint: Color
    let shimmering: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: DesignTokens.ProcessRow.gap) {
            Icon(icon, size: DesignTokens.IconSize.processRow)
                .foregroundStyle(tint)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 6 }
            if shimmering {
                ShimmerText(text: text)
            } else {
                Text(text)
                    .hmType(ProcessRowText.type)
                    .foregroundStyle(tint)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .id(text)
        .transition(.opacity)
        .accessibilityElement(children: .combine)
    }
}

struct ShimmerText: View {
    let text: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.stillFrames) private var stillFrames

    var body: some View {
        if reduceMotion || stillFrames {
            label.foregroundStyle(Color.hmMuted)
        } else {
            TimelineView(.animation) { context in
                let cycle = Double(DesignTokens.ProcessRow.shimmerSeconds)
                let progress = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: cycle) / cycle
                let center = 1.3 - 2.4 * progress
                label.foregroundStyle(
                    LinearGradient(
                        stops: [
                            .init(color: .hmMuted, location: 0),
                            .init(color: .hmMuted, location: 0.38),
                            .init(color: .hmText, location: 0.5),
                            .init(color: .hmMuted, location: 0.62),
                            .init(color: .hmMuted, location: 1),
                        ],
                        startPoint: UnitPoint(x: center - 1.2, y: 0.5),
                        endPoint: UnitPoint(x: center + 1.2, y: 0.5)
                    )
                )
            }
        }
    }

    private var label: Text {
        Text(text).hmText(DesignTokens.TypeScale.body)
    }
}

extension EnvironmentValues {
    @Entry public var processStepsOpenAfter: Double? = nil
    @Entry public var transcriptScrollsToTopAfter: Double? = nil
    @Entry public var listClock: Date? = nil
}

enum ProcessRowText {
    static let type = TypeToken(size: DesignTokens.ProcessRow.fontSize, weight: 400, lineHeight: nil, face: .system, tracking: 0)
}
