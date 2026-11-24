#if os(watchOS)
import HimawariCore
import HimawariDesign
import SwiftUI
import WidgetKit

public struct WatchGlanceView: View {
    private let state: WatchComplicationState
    private let family: WidgetFamily

    public init(state: WatchComplicationState, family: WidgetFamily) {
        self.state = state
        self.family = family
    }

    private func waitingText(_ count: Int) -> String {
        L.format("glance.waiting", count)
    }

    public var body: some View {
        switch family {
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                if case let .waiting(count, _) = state.display {
                    Text("\(count)")
                        .font(.system(.title2, design: .rounded, weight: .bold))
                        .widgetAccentable()
                } else {
                    SunflowerMark().padding(DesignTokens.Watch.glanceMarkInset).widgetAccentable()
                }
            }
        case .accessoryInline:
            if case let .waiting(count, _) = state.display {
                Text(waitingText(count))
            }
        case .accessoryCorner:
            if case let .waiting(count, _) = state.display {
                Text("\(count)").widgetCurvesContent().widgetLabel { Text(waitingText(count)) }
            } else {
                SunflowerMark().widgetLabel { Text(L.text("reminder.title")) }
            }
        default:
            rectangular
        }
    }

    private var rectangular: some View {
        HStack(spacing: DesignTokens.Watch.glanceGap) {
            SunflowerMark()
                .frame(width: DesignTokens.Watch.markWidget, height: DesignTokens.Watch.markWidget)
                .widgetAccentable()
            VStack(alignment: .leading, spacing: 1) {
                switch state.display {
                case let .waiting(count, latest):
                    Text(waitingText(count))
                        .font(.system(.footnote, design: .rounded, weight: .semibold))
                    if let latest {
                        Text(latest).font(.caption2).fontWeight(.regular).foregroundStyle(Color.hmMuted).lineLimit(2)
                    }
                case .nothingWaiting:
                    Text(L.text("glance.quiet"))
                        .font(.system(.footnote, design: .rounded, weight: .semibold))
                case .unknown:
                    Text(L.text("reminder.title")).font(.system(.footnote, design: .rounded, weight: .semibold))
                }
            }
            Spacer(minLength: 0)
        }
    }
}
#endif
