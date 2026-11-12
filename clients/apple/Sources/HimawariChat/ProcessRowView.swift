import HimawariCore
import HimawariDesign
import SwiftUI

struct ProcessRowView: View {
    let line: ProcessLine
    @State private var expanded = false

    var body: some View {
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
                } else {
                    ProcessLineLabel(icon: Self.icon(current.icon), text: current.title, tint: .hmMuted, shimmering: true)
                }
            }
            .animation(.easeInOut(duration: 0.25), value: current.id)
        case let .waiting(step):
            ProcessLineLabel(icon: .handStop, text: step.title, tint: .hmSun, shimmering: false)
        case let .finished(steps, seconds):
            summary(icon: .check, title: L.text("process.finished"), steps: steps, seconds: seconds)
        case let .stopped(steps, seconds):
            summary(icon: .playerStop, title: L.text("process.stopped"), steps: steps, seconds: seconds)
        }
    }

    private func summary(icon: IconName, title: String, steps: [ProcessStep], seconds: Int) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Button {
                withAnimation(.easeInOut(duration: 0.25)) { expanded.toggle() }
            } label: {
                HStack(spacing: 10) {
                    Icon(icon, size: 24)
                    Text(title)
                        .font(.system(size: 17))
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(L.format("process.seconds", seconds))
                        .font(.system(size: 15))
                        .monospacedDigit()
                    if !steps.isEmpty {
                        Icon(.chevronRight, size: 16)
                            .rotationEffect(.degrees(expanded ? 90 : 0))
                    }
                }
                .foregroundStyle(Color.hmMuted)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(steps.isEmpty)
            .accessibilityHint(Text(L.text(expanded ? "process.collapse" : "process.expand")))
            if expanded {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(steps) { step in
                        ProcessLineLabel(
                            icon: step.phase == .failed || step.phase == .unavailable ? .alertCircle : Self.icon(step.icon),
                            text: step.title,
                            tint: .hmMuted,
                            shimmering: false
                        )
                    }
                }
                .padding(.leading, 34)
                .transition(.opacity)
            }
        }
    }

    static func icon(_ icon: ProcessIcon) -> IconName {
        IconName(rawValue: icon.rawValue) ?? .tools
    }
}

struct ProcessLineLabel: View {
    let icon: IconName
    let text: String
    let tint: Color
    let shimmering: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Icon(icon, size: 24)
                .foregroundStyle(tint)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 6 }
            if shimmering {
                ShimmerText(text: text)
            } else {
                Text(text)
                    .font(.system(size: 17))
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

    var body: some View {
        if reduceMotion {
            label.foregroundStyle(Color.hmMuted)
        } else {
            TimelineView(.animation) { context in
                let cycle = 2.4
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
        Text(text).font(.system(size: 17))
    }
}
