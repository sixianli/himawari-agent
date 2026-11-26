import HimawariCore
import HimawariDesign
import SwiftUI

enum BubbleSide {
    case her
    case owner
}

struct BubbleTail: Shape {
    let side: BubbleSide
    var radius: CGFloat = DesignTokens.Chat.bubbleRadius

    func path(in rect: CGRect) -> Path {
        let width = DesignTokens.Chat.bubbleTailWidth
        let height = min(DesignTokens.Chat.bubbleTailHeight, rect.height / 2)
        let x = rect.maxX
        let y = rect.maxY
        var hook = Path()
        hook.move(to: CGPoint(x: x - 1, y: y - height))
        hook.addCurve(
            to: CGPoint(x: x + width, y: y),
            control1: CGPoint(x: x - 1, y: y - height * 0.3),
            control2: CGPoint(x: x + width * 0.4, y: y - 0.5)
        )
        hook.addCurve(
            to: CGPoint(x: x - radius * 0.7, y: y - 1.5),
            control1: CGPoint(x: x + width * 0.2, y: y + 0.8),
            control2: CGPoint(x: x - radius * 0.3, y: y)
        )
        hook.addLine(to: CGPoint(x: x - radius, y: y - height))
        hook.closeSubpath()
        guard side == .her else { return hook }
        return hook.applying(CGAffineTransform(translationX: rect.minX + rect.maxX, y: 0).scaledBy(x: -1, y: 1))
    }
}

struct BubbleBackground: ViewModifier {
    let side: BubbleSide
    let tail: Bool

    @ScaledMetric(relativeTo: .body) private var paddingX = DesignTokens.Chat.bubblePaddingX
    @ScaledMetric(relativeTo: .body) private var paddingY = DesignTokens.Chat.bubblePaddingY
    @ScaledMetric(relativeTo: .body) private var radius = DesignTokens.Chat.bubbleRadius

    func body(content: Content) -> some View {
        let fill = side == .her ? Color.hmBubble : Color.hmText
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        content
            .padding(.horizontal, paddingX)
            .padding(.vertical, paddingY)
            .background {
                if tail { BubbleTail(side: side, radius: radius).fill(fill) }
            }
            .background(fill, in: shape)
            .menuPreviewShape(shape)
    }
}

extension View {
    @ViewBuilder
    fileprivate func menuPreviewShape(_ shape: some Shape) -> some View {
        #if os(iOS)
        contentShape(.contextMenuPreview, shape)
        #else
        self
        #endif
    }
}

extension View {
    func bubble(_ side: BubbleSide, tail: Bool) -> some View {
        modifier(BubbleBackground(side: side, tail: tail))
    }
}

struct BubbleTimeLine: View {
    let date: Date

    var body: some View {
        Text(BubbleTime.label(date, now: Date()))
            .font(.caption)
            .foregroundStyle(Color.hmMuted)
            .frame(maxWidth: .infinity)
            .padding(.vertical, DesignTokens.Chat.bubbleTimePaddingY)
    }
}

enum BubbleTime {
    private static let relative: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .short
        formatter.doesRelativeDateFormatting = true
        return formatter
    }()

    static func label(_ date: Date, now: Date, calendar: Calendar = .current) -> String {
        if calendar.isDate(date, inSameDayAs: now) || calendar.isDate(date, inSameDayAs: calendar.date(byAdding: .day, value: -1, to: now) ?? now) {
            return relative.string(from: date)
        }
        if calendar.isDate(date, equalTo: now, toGranularity: .year) {
            return date.formatted(.dateTime.month().day().hour().minute())
        }
        return date.formatted(.dateTime.year().month().day().hour().minute())
    }
}

enum BubbleDates {
    private static let parsed = TextMemo<Date?>(limit: 4000)

    static func date(_ committedAt: String) -> Date? {
        parsed.value(for: committedAt) { text in
            (try? Date(text, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)))
                ?? (try? Date(text, strategy: Date.ISO8601FormatStyle()))
        }
    }
}

extension Color {
    static var hmBubble: Color { DesignTokens.Colors.bubble.color }
    static var hmBubbleCode: Color { DesignTokens.Colors.bubbleCode.color }
}
