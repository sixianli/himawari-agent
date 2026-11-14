import HimawariCore
import HimawariDesign
import SwiftUI
import WidgetKit

struct GlanceEntry: TimelineEntry {
    let date: Date
    let state: WatchComplicationState
}

struct GlanceProvider: TimelineProvider {
    private var store: WatchComplicationStore {
        WatchComplicationStore(appGroup: Bundle.main.object(forInfoDictionaryKey: "HimawariAppGroup") as? String ?? "")
    }

    func placeholder(in context: Context) -> GlanceEntry {
        GlanceEntry(date: Date(), state: WatchComplicationState(awaiting: 3, latest: nil, updatedAt: Date()))
    }

    func getSnapshot(in context: Context, completion: @escaping (GlanceEntry) -> Void) {
        completion(GlanceEntry(date: Date(), state: context.isPreview ? placeholder(in: context).state : store.load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<GlanceEntry>) -> Void) {
        completion(Timeline(entries: [GlanceEntry(date: Date(), state: store.load())], policy: .never))
    }
}

struct GlanceView: View {
    @Environment(\.widgetFamily) private var family
    let entry: GlanceEntry

    var body: some View {
        switch family {
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                if case let .waiting(count, _) = entry.state.display {
                    Text("\(count)")
                        .font(.system(.title2, design: .rounded, weight: .bold))
                        .widgetAccentable()
                } else {
                    SunflowerMark(detail: .compact).padding(4).widgetAccentable()
                }
            }
        case .accessoryInline:
            if case let .waiting(count, _) = entry.state.display {
                Text(String(format: String(localized: "glance.waiting"), count))
            }
        case .accessoryCorner:
            if case let .waiting(count, _) = entry.state.display {
                Text("\(count)").widgetCurvesContent().widgetLabel { Text(String(format: String(localized: "glance.waiting"), count)) }
            } else {
                SunflowerMark(detail: .compact).widgetLabel { Text("Himawari") }
            }
        default:
            rectangular
        }
    }

    private var rectangular: some View {
        HStack(spacing: 8) {
            SunflowerMark(detail: .compact)
                .frame(width: DesignTokens.Watch.markWidget, height: DesignTokens.Watch.markWidget)
                .widgetAccentable()
            VStack(alignment: .leading, spacing: 1) {
                switch entry.state.display {
                case let .waiting(count, latest):
                    Text(String(format: String(localized: "glance.waiting"), count))
                        .font(.system(.footnote, design: .rounded, weight: .semibold))
                    if let latest {
                        Text(latest).font(.caption2).lineLimit(2)
                    }
                case .nothingWaiting:
                    Text(String(localized: "glance.quiet"))
                        .font(.system(.footnote, design: .rounded, weight: .semibold))
                case .unknown:
                    Text("Himawari").font(.system(.footnote, design: .rounded, weight: .semibold))
                }
            }
            Spacer(minLength: 0)
        }
    }
}

struct GlanceWidget: Widget {
    let kind = "himawari.watch.glance"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: GlanceProvider()) { entry in
            GlanceView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Himawari")
        .supportedFamilies([.accessoryRectangular, .accessoryCircular, .accessoryInline, .accessoryCorner])
    }
}

@main
struct HimawariWatchWidgets: WidgetBundle {
    var body: some Widget {
        GlanceWidget()
    }
}
