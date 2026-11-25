import Foundation

public enum AnswerBlock: Equatable, Sendable {
    case paragraph(String)
    case heading(level: Int, text: String)
    case bullets([String])
    case numbered(start: Int, items: [String])
    case quote(String)
    case code(language: String?, text: String)
    case table(header: [String], rows: [[String]])
    case rule
}

public enum AnswerMarkdown {
    public static func blocks(_ text: String, streaming: Bool = false) -> [AnswerBlock] {
        let source = streaming ? settled(text) : text
        var parser = Parser(lines: source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n"))
        return parser.run(streaming: streaming)
    }

    public static func settled(_ text: String) -> String {
        var kept = text
        while let last = kept.last, last == "*" || last == "_" || last == "`" || last == "~" {
            kept.removeLast()
        }
        if kept.isEmpty { return kept }
        var fenceOpen = false
        var strong = 0
        var code = 0
        for line in kept.components(separatedBy: "\n") {
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                fenceOpen.toggle()
                continue
            }
            if fenceOpen { continue }
            strong += line.components(separatedBy: "**").count - 1
            code += line.filter { $0 == "`" }.count
        }
        if fenceOpen { return kept }
        if code % 2 == 1 { kept += "`" }
        if strong % 2 == 1 { kept += "**" }
        return kept
    }

    static func cells(_ line: String) -> [String] {
        var body = line.trimmingCharacters(in: .whitespaces)
        if body.hasPrefix("|") { body.removeFirst() }
        if body.hasSuffix("|"), !body.hasSuffix("\\|") { body.removeLast() }
        var cells: [String] = []
        var current = ""
        var escaped = false
        for character in body {
            if escaped {
                current.append(character == "|" ? "|" : "\\\(character)")
                escaped = false
            } else if character == "\\" {
                escaped = true
            } else if character == "|" {
                cells.append(current.trimmingCharacters(in: .whitespaces))
                current = ""
            } else {
                current.append(character)
            }
        }
        if escaped { current.append("\\") }
        cells.append(current.trimmingCharacters(in: .whitespaces))
        return cells
    }

    static func isDelimiterRow(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.contains("-") else { return false }
        let parts = cells(trimmed)
        return !parts.isEmpty && parts.allSatisfy { part in
            var core = Substring(part)
            if core.hasPrefix(":") { core = core.dropFirst() }
            if core.hasSuffix(":") { core = core.dropLast() }
            return !core.isEmpty && core.allSatisfy { $0 == "-" }
        }
    }

    static func heading(_ line: String) -> (Int, String)? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        let hashes = trimmed.prefix(while: { $0 == "#" }).count
        guard (1...6).contains(hashes) else { return nil }
        let rest = trimmed.dropFirst(hashes)
        guard rest.isEmpty || rest.first == " " else { return nil }
        var text = rest.trimmingCharacters(in: .whitespaces)
        while text.hasSuffix("#") { text.removeLast() }
        return (hashes, text.trimmingCharacters(in: .whitespaces))
    }

    static func isRule(_ line: String) -> Bool {
        let compact = line.filter { !$0.isWhitespace }
        guard compact.count >= 3, let first = compact.first, "-*_".contains(first) else { return false }
        return compact.allSatisfy { $0 == first }
    }

    static func bullet(_ line: String) -> String? {
        let trimmed = line.drop(while: { $0 == " " || $0 == "\t" })
        guard let marker = trimmed.first, "-*+•".contains(marker) else { return nil }
        let rest = trimmed.dropFirst()
        guard rest.first == " " || rest.first == "\t" else { return nil }
        return rest.trimmingCharacters(in: .whitespaces)
    }

    static func numbered(_ line: String) -> (Int, String)? {
        let trimmed = line.drop(while: { $0 == " " || $0 == "\t" })
        let digits = trimmed.prefix(while: { $0.isASCII && $0.isNumber })
        guard !digits.isEmpty, digits.count <= 9, let number = Int(digits) else { return nil }
        let rest = trimmed.dropFirst(digits.count)
        guard let mark = rest.first, mark == "." || mark == ")" else { return nil }
        let after = rest.dropFirst()
        guard after.first == " " || after.first == "\t" else { return nil }
        return (number, after.trimmingCharacters(in: .whitespaces))
    }

    static func quote(_ line: String) -> String? {
        let trimmed = line.drop(while: { $0 == " " })
        guard trimmed.first == ">" else { return nil }
        let rest = trimmed.dropFirst()
        return String(rest.first == " " ? rest.dropFirst() : rest)
    }

    private struct Parser {
        let lines: [String]
        var index = 0
        var blocks: [AnswerBlock] = []
        var paragraph: [String] = []

        init(lines: [String]) {
            self.lines = lines
        }

        mutating func run(streaming: Bool) -> [AnswerBlock] {
            while index < lines.count {
                let line = lines[index]
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                if trimmed.isEmpty {
                    flush()
                    index += 1
                } else if trimmed.hasPrefix("```") {
                    flush()
                    fence(opening: trimmed)
                } else if let (level, text) = AnswerMarkdown.heading(line) {
                    flush()
                    blocks.append(.heading(level: level, text: text))
                    index += 1
                } else if AnswerMarkdown.isRule(line) {
                    flush()
                    blocks.append(.rule)
                    index += 1
                } else if trimmed.contains("|"), index + 1 < lines.count, AnswerMarkdown.isDelimiterRow(lines[index + 1]) {
                    flush()
                    table()
                } else if AnswerMarkdown.bullet(line) != nil {
                    flush()
                    list(numbered: false)
                } else if AnswerMarkdown.numbered(line) != nil {
                    flush()
                    list(numbered: true)
                } else if AnswerMarkdown.quote(line) != nil {
                    flush()
                    quoteBlock()
                } else {
                    paragraph.append(trimmed)
                    index += 1
                }
            }
            flush()
            return blocks
        }

        mutating func flush() {
            guard !paragraph.isEmpty else { return }
            blocks.append(.paragraph(paragraph.joined(separator: "\n")))
            paragraph = []
        }

        mutating func fence(opening: String) {
            let language = opening.dropFirst(3).trimmingCharacters(in: .whitespaces)
            index += 1
            var body: [String] = []
            while index < lines.count {
                if lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                    index += 1
                    break
                }
                body.append(lines[index])
                index += 1
            }
            blocks.append(.code(language: language.isEmpty ? nil : language, text: body.joined(separator: "\n")))
        }

        mutating func table() {
            let header = AnswerMarkdown.cells(lines[index])
            index += 2
            var rows: [[String]] = []
            while index < lines.count {
                let line = lines[index]
                guard line.contains("|"), !line.trimmingCharacters(in: .whitespaces).isEmpty else { break }
                var row = AnswerMarkdown.cells(line)
                if row.count < header.count { row += Array(repeating: "", count: header.count - row.count) }
                rows.append(Array(row.prefix(header.count)))
                index += 1
            }
            blocks.append(.table(header: header, rows: rows))
        }

        mutating func list(numbered: Bool) {
            var items: [String] = []
            var start = 1
            while index < lines.count {
                let line = lines[index]
                if numbered, let (number, text) = AnswerMarkdown.numbered(line) {
                    if items.isEmpty { start = number }
                    items.append(text)
                } else if !numbered, let text = AnswerMarkdown.bullet(line) {
                    items.append(text)
                } else if !items.isEmpty, line.hasPrefix("  "), !line.trimmingCharacters(in: .whitespaces).isEmpty,
                          AnswerMarkdown.bullet(line) == nil, AnswerMarkdown.numbered(line) == nil {
                    items[items.count - 1] += "\n" + line.trimmingCharacters(in: .whitespaces)
                } else {
                    break
                }
                index += 1
            }
            blocks.append(numbered ? .numbered(start: start, items: items) : .bullets(items))
        }

        mutating func quoteBlock() {
            var body: [String] = []
            while index < lines.count, let text = AnswerMarkdown.quote(lines[index]) {
                body.append(text)
                index += 1
            }
            blocks.append(.quote(body.joined(separator: "\n")))
        }
    }
}
