#if os(macOS)
@preconcurrency import AVFoundation
import Foundation
import HimawariCore
import HimawariListenEngine

@main
struct ListenEval {
    static func main() async {
        let arguments = Array(CommandLine.arguments.dropFirst())
        guard let command = arguments.first else {
            fail(usage)
        }
        let options = Options(Array(arguments.dropFirst()))
        do {
            switch command {
            case "synthesize": try Synthesize(options: options).run()
            case "prepare": try Prepare(options: options).run()
            case "run": try await Run(options: options).run()
            default: fail(usage)
            }
        } catch {
            fail("\(error)")
        }
    }

    static let usage = """
    himawari-listen-eval synthesize --out DIR
    himawari-listen-eval prepare --phone DIR --corpora DIR --synthetic DIR --out DIR [--seed 8] [--noise-snr 5] [--far-db 20]
    himawari-listen-eval run --clips DIR [--engines transcriber,dictation] [--out FILE]
    """

    static func fail(_ message: String) -> Never {
        FileHandle.standardError.write(Data((message + "\n").utf8))
        exit(1)
    }
}

struct Options {
    private var values: [String: String] = [:]

    init(_ arguments: [String]) {
        var index = 0
        while index < arguments.count {
            let key = arguments[index]
            if key.hasPrefix("--"), index + 1 < arguments.count {
                values[String(key.dropFirst(2))] = arguments[index + 1]
                index += 2
            } else {
                index += 1
            }
        }
    }

    func path(_ key: String) throws -> URL {
        guard let value = values[key] else { throw EvalFailure.missingOption(key) }
        return URL(fileURLWithPath: (value as NSString).expandingTildeInPath)
    }

    func optionalPath(_ key: String) -> URL? {
        values[key].map { URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath) }
    }

    func number(_ key: String, default fallback: Double) -> Double {
        values[key].flatMap(Double.init) ?? fallback
    }

    func list(_ key: String, default fallback: [String]) -> [String] {
        values[key].map { $0.split(separator: ",").map(String.init) } ?? fallback
    }
}

enum EvalFailure: Error, CustomStringConvertible {
    case missingOption(String)
    case missingFile(String)
    case noVoices(String)
    case synthesisFailed(String)
    case noEnrollment

    var description: String {
        switch self {
        case let .missingOption(key): "missing --\(key)"
        case let .missingFile(path): "file not found: \(path)"
        case let .noVoices(language): "no installed system voice for \(language); add one in System Settings → Accessibility → Spoken Content"
        case let .synthesisFailed(text): "say failed for: \(text)"
        case .noEnrollment: "the phone folder has no voiceprint recordings (enroll-001 … enroll-003)"
        }
    }
}

struct SyntheticClip: Codable {
    let file: String
    let purpose: ListenEvalPurpose
    let language: String
    let text: String
    let voice: String
}

struct SeededGenerator: RandomNumberGenerator {
    private var state: UInt64

    init(seed: UInt64) {
        state = seed
    }

    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var value = state
        value = (value ^ (value >> 30)) &* 0xBF58_476D_1CE4_E5B9
        value = (value ^ (value >> 27)) &* 0x94D0_49BB_1331_11EB
        return value ^ (value >> 31)
    }
}

enum Audio {
    static let rate = FluidSpeakerEmbedder.sampleRate

    static func chunks(_ url: URL, seconds: Double = 1) throws -> [AVAudioPCMBuffer] {
        let file = try AVAudioFile(forReading: url)
        let format = file.processingFormat
        let size = AVAudioFrameCount(max(1, format.sampleRate * seconds))
        var buffers: [AVAudioPCMBuffer] = []
        while file.framePosition < file.length {
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: size) else { break }
            try file.read(into: buffer, frameCount: size)
            if buffer.frameLength == 0 { break }
            buffers.append(buffer)
        }
        return buffers
    }

    static func monoSamples(_ buffers: [AVAudioPCMBuffer]) -> [Float] {
        let seconds = buffers.reduce(0.0) { $0 + Double($1.frameLength) / $1.format.sampleRate }
        let window = SpeakerAudioWindow(seconds: seconds + 2)
        window.reset(at: 0)
        for buffer in buffers { window.append(buffer) }
        return window.slice(from: 0, to: seconds + 2)
    }

    static func monoSamples(_ url: URL) throws -> [Float] {
        try monoSamples(chunks(url))
    }

    static func write(_ samples: [Float], to url: URL) throws {
        guard
            let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false),
            let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(max(1, samples.count))),
            let channel = buffer.floatChannelData?[0]
        else { throw EvalFailure.missingFile(url.path) }
        for (index, value) in samples.enumerated() { channel[index] = value }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        let file = try AVAudioFile(forWriting: url, settings: format.settings, commonFormat: .pcmFormatFloat32, interleaved: false)
        try file.write(from: buffer)
    }

    static func power(_ samples: [Float]) -> Double {
        guard !samples.isEmpty else { return 0 }
        return samples.reduce(0.0) { $0 + Double($1) * Double($1) } / Double(samples.count)
    }

    static func mix(_ signal: [Float], noise: [Float], snr: Double) -> [Float] {
        guard !noise.isEmpty else { return signal }
        let signalPower = power(signal)
        let noisePower = power(noise)
        guard signalPower > 0, noisePower > 0 else { return signal }
        let gain = Float((signalPower / (noisePower * pow(10, snr / 10))).squareRoot())
        return signal.indices.map { signal[$0] + gain * noise[$0 % noise.count] }
    }

    static func attenuate(_ samples: [Float], decibels: Double) -> [Float] {
        let gain = Float(pow(10, -decibels / 20))
        return samples.map { $0 * gain }
    }

    static func babble(_ voices: [[Float]]) -> [Float] {
        let length = voices.map(\.count).max() ?? 0
        guard length > 0 else { return [] }
        var mixed = [Float](repeating: 0, count: length)
        for voice in voices where !voice.isEmpty {
            for index in 0..<length { mixed[index] += voice[index % voice.count] }
        }
        return mixed
    }
}

struct Synthesize {
    let options: Options

    func run() throws {
        let out = try options.path("out")
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let kit = try ListenResources.evalKit()
        let voices = try installedVoices()
        var clips: [SyntheticClip] = []
        let lines = kit.synthetic.bystander.map { (ListenEvalPurpose.bystander, $0) } + kit.synthetic.tvMention.map { (ListenEvalPurpose.tvMention, $0) }
        var counters: [ListenEvalPurpose: Int] = [:]
        for (purpose, line) in lines {
            let prefix = String(line.language.prefix(2))
            guard let choices = voices[prefix], !choices.isEmpty else { throw EvalFailure.noVoices(line.language) }
            let index = counters[purpose, default: 0]
            counters[purpose] = index + 1
            let voice = choices[index % choices.count]
            let name = "\(purpose.rawValue)-\(String(format: "%03d", index + 1)).wav"
            try say(line.text, voice: voice, to: out.appendingPathComponent(name))
            clips.append(SyntheticClip(file: name, purpose: purpose, language: line.language, text: line.text, voice: voice))
        }
        try encoder().encode(clips).write(to: out.appendingPathComponent("synthetic.json"))
        print("synthesized \(clips.count) clips with voices \(voices)")
    }

    func installedVoices() throws -> [String: [String]] {
        let listing = try shell("/usr/bin/say", ["-v", "?"])
        var voices: [String: [String]] = [:]
        for line in listing.split(separator: "\n") {
            guard let hash = line.range(of: "#") else { continue }
            let head = line[..<hash.lowerBound].split(separator: " ", omittingEmptySubsequences: true)
            guard let locale = head.last, locale.contains("_") else { continue }
            let name = head.dropLast().joined(separator: " ")
            let language = String(locale.prefix(2))
            guard ["zh", "ja", "en"].contains(language) else { continue }
            voices[language, default: []].append(name)
        }
        return voices.mapValues { Array($0.sorted().prefix(4)) }
    }

    func say(_ text: String, voice: String, to url: URL) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/say")
        process.arguments = ["-v", voice, "-o", url.path, "--file-format=WAVE", "--data-format=LEF32@16000", text]
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw EvalFailure.synthesisFailed(text) }
    }
}

func shell(_ executable: String, _ arguments: [String]) throws -> String {
    let process = Process()
    let pipe = Pipe()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.standardOutput = pipe
    try process.run()
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return String(decoding: data, as: UTF8.self)
}

func encoder() -> JSONEncoder {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    return encoder
}

struct FleursRow {
    let file: URL
    let text: String
    let seconds: Double
    let gender: String
}

struct Prepare {
    let options: Options

    static let speakerFromLibriSpeech = 10
    static let utterancesPerLibriSpeaker = 8
    static let fleursSpeakerClips = 60
    static let transcriptionSeconds = 1800.0
    static let fleursLanguages = [("zh-Hans", "cmn_hans_cn"), ("ja", "ja_jp"), ("en", "en_us")]

    func run() throws {
        let phone = try options.path("phone")
        let corpora = try options.path("corpora")
        let synthetic = try options.path("synthetic")
        let out = try options.path("out")
        let audio = out.appendingPathComponent("audio", isDirectory: true)
        try FileManager.default.createDirectory(at: audio, withIntermediateDirectories: true)
        var random = SeededGenerator(seed: UInt64(options.number("seed", default: 8)))
        let snr = options.number("noise-snr", default: 5)
        let farDB = options.number("far-db", default: 20)

        var clips = try ownerClips(phone)
        var fleurs: [String: [FleursRow]] = [:]
        for (language, folder) in Self.fleursLanguages {
            fleurs[language] = try fleursRows(corpora.appendingPathComponent("fleurs/\(folder)")).shuffled(using: &random)
        }
        let babblePool = try (fleurs["en"] ?? []).prefix(40).map { try Audio.monoSamples($0.file) }
        func babble() -> [Float] {
            Audio.babble((0..<3).compactMap { _ in babblePool.randomElement(using: &random) })
        }

        var noisyToggle = false
        func add(_ id: String, source url: URL, purpose: ListenEvalPurpose, source: ListenEvalSource, speaker: String, language: String, reference: String, placement: ListenEvalPlacement = .hand, route: AudioInputRoute = .deviceMicrophone, inEar: Bool? = nil, alternateNoise: Bool) throws {
            var condition = ListenEvalCondition.quiet
            var file = url.path
            if alternateNoise {
                noisyToggle.toggle()
                if noisyToggle {
                    condition = .noisy
                    let mixed = try Audio.mix(Audio.monoSamples(url), noise: babble(), snr: snr)
                    let target = audio.appendingPathComponent("\(id).wav")
                    try Audio.write(mixed, to: target)
                    file = target.path
                }
            }
            clips.append(ListenEvalClip(id: id, file: file, purpose: purpose, source: source, speaker: speaker, language: language, reference: reference, placement: placement, condition: condition, route: route, inEar: inEar))
        }

        for (speaker, utterances) in try libriSpeech(corpora.appendingPathComponent("LibriSpeech/test-clean"), random: &random) {
            for (id, url, text) in utterances {
                try add("librispeech-\(id)", source: url, purpose: .speaker, source: .publicCorpus, speaker: "librispeech:\(speaker)", language: "en", reference: text, alternateNoise: true)
            }
        }
        for language in ["zh-Hans", "ja"] {
            for row in (fleurs[language] ?? []).prefix(Self.fleursSpeakerClips) {
                let stem = row.file.deletingPathExtension().lastPathComponent
                try add("fleurs-speaker-\(language)-\(stem)", source: row.file, purpose: .speaker, source: .publicCorpus, speaker: "fleurs:\(language):\(stem)", language: language, reference: row.text, alternateNoise: true)
            }
        }
        for (language, _) in Self.fleursLanguages {
            var total = 0.0
            let skip = language == "en" ? 40 : Self.fleursSpeakerClips
            for row in (fleurs[language] ?? []).dropFirst(skip) where total < Self.transcriptionSeconds {
                total += row.seconds
                let stem = row.file.deletingPathExtension().lastPathComponent
                try add("fleurs-asr-\(language)-\(stem)", source: row.file, purpose: .publicSpeech, source: .publicCorpus, speaker: "fleurs:\(language):\(stem)", language: language, reference: row.text, alternateNoise: false)
            }
        }

        let made = try JSONDecoder().decode([SyntheticClip].self, from: Data(contentsOf: synthetic.appendingPathComponent("synthetic.json")))
        for clip in made {
            let source = synthetic.appendingPathComponent(clip.file)
            let samples = try Audio.monoSamples(source)
            let stem = (clip.file as NSString).deletingPathExtension
            let tableURL = audio.appendingPathComponent("\(stem)-table.wav")
            try Audio.write(Audio.mix(samples, noise: babble(), snr: snr + 10), to: tableURL)
            clips.append(ListenEvalClip(id: "\(stem)-table", file: tableURL.path, purpose: clip.purpose, source: .synthetic, speaker: "synthetic:\(clip.voice)", language: clip.language, reference: clip.text, placement: .table, condition: .everyday, route: .deviceMicrophone, inEar: nil))
            let farURL = audio.appendingPathComponent("\(stem)-airpods.wav")
            try Audio.write(Audio.attenuate(samples, decibels: farDB), to: farURL)
            clips.append(ListenEvalClip(id: "\(stem)-airpods", file: farURL.path, purpose: clip.purpose, source: .synthetic, speaker: "synthetic:\(clip.voice)", language: clip.language, reference: clip.text, placement: .airpods, condition: .everyday, route: .airpods, inEar: true))
        }

        try encoder().encode(clips).write(to: out.appendingPathComponent("clips.json"))
        var counts: [String: Int] = [:]
        for clip in clips { counts["\(clip.source.rawValue)/\(clip.purpose.rawValue)", default: 0] += 1 }
        for key in counts.keys.sorted() { print("\(key): \(counts[key] ?? 0)") }
    }

    func ownerClips(_ phone: URL) throws -> [ListenEvalClip] {
        let kit = try ListenResources.evalKit()
        let manifest = phone.appendingPathComponent(ListenEvalSession.manifestName)
        guard FileManager.default.fileExists(atPath: manifest.path) else { throw EvalFailure.missingFile(manifest.path) }
        let session = try ListenEvalSession.decode(Data(contentsOf: manifest))
        return session.recordings.compactMap { recording in
            guard let stage = kit.stage(containing: recording.promptId), let prompt = stage.prompts.first(where: { $0.id == recording.promptId }) else { return nil }
            return ListenEvalClip(
                id: "owner-\(recording.promptId)",
                file: phone.appendingPathComponent(recording.file).path,
                purpose: stage.purpose,
                source: .owner,
                speaker: "owner",
                language: prompt.language,
                reference: prompt.text,
                placement: stage.placement,
                condition: stage.condition,
                route: recording.route,
                inEar: recording.inEar
            )
        }
    }

    func fleursRows(_ folder: URL) throws -> [FleursRow] {
        let tsv = folder.appendingPathComponent("test.tsv")
        guard FileManager.default.fileExists(atPath: tsv.path) else { throw EvalFailure.missingFile(tsv.path) }
        let text = try String(contentsOf: tsv, encoding: .utf8)
        return text.split(separator: "\n").compactMap { line in
            let columns = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
            guard columns.count >= 7, let samples = Double(columns[5]) else { return nil }
            let file = folder.appendingPathComponent("audio/test/\(columns[1])")
            guard FileManager.default.fileExists(atPath: file.path) else { return nil }
            return FleursRow(file: file, text: columns[2], seconds: samples / 16_000, gender: columns[6])
        }
    }

    func libriSpeech(_ root: URL, random: inout SeededGenerator) throws -> [(String, [(String, URL, String)])] {
        let manager = FileManager.default
        guard manager.fileExists(atPath: root.path) else { throw EvalFailure.missingFile(root.path) }
        let speakers = try manager.contentsOfDirectory(atPath: root.path).filter { Int($0) != nil }.sorted().shuffled(using: &random).prefix(Self.speakerFromLibriSpeech)
        return try speakers.map { speaker in
            var utterances: [(String, URL, String)] = []
            let speakerURL = root.appendingPathComponent(speaker)
            for chapter in try manager.contentsOfDirectory(atPath: speakerURL.path).sorted() {
                let chapterURL = speakerURL.appendingPathComponent(chapter)
                let transcript = chapterURL.appendingPathComponent("\(speaker)-\(chapter).trans.txt")
                guard let text = try? String(contentsOf: transcript, encoding: .utf8) else { continue }
                for line in text.split(separator: "\n") {
                    guard let space = line.firstIndex(of: " ") else { continue }
                    let id = String(line[..<space])
                    utterances.append((id, chapterURL.appendingPathComponent("\(id).flac"), String(line[line.index(after: space)...])))
                }
            }
            return (speaker, Array(utterances.shuffled(using: &random).prefix(Self.utterancesPerLibriSpeaker)))
        }
    }
}

final class PieceBox: @unchecked Sendable {
    private let lock = NSLock()
    private var pieces: [ListenEvalPiece] = []

    func add(_ piece: TranscriptPiece) {
        lock.withLock {
            pieces.append(ListenEvalPiece(at: piece.end, start: piece.start, text: piece.text, isFinal: piece.isFinal))
        }
    }

    var all: [ListenEvalPiece] {
        lock.withLock { pieces }
    }
}

struct Run {
    let options: Options

    static let locales: [String: [String]] = [
        "zh-Hans": ["zh-CN"],
        "ja": ["ja-JP"],
        "en": ["en-US"],
        "mixed": ["zh-CN", "ja-JP", "en-US"],
    ]

    func run() async throws {
        let folder = try options.path("clips")
        let out = options.optionalPath("out") ?? folder.appendingPathComponent("observations.jsonl")
        let engines = options.list("engines", default: SpeechEngine.allCases.map(\.rawValue)).compactMap(SpeechEngine.init(rawValue:))
        let clips = try JSONDecoder().decode([ListenEvalClip].self, from: Data(contentsOf: folder.appendingPathComponent("clips.json")))
        let names = NameCall(names: ListenResources.names())
        let embedder = FluidSpeakerEmbedder()
        try await embedder.prepare()

        var enrolled: [[Float]] = []
        for clip in clips where clip.purpose == .enrollment && clip.source == .owner {
            let samples = try Audio.monoSamples(URL(fileURLWithPath: clip.file))
            enrolled.append(try await embedder.embedding(samples: samples, sampleRate: Audio.rate))
        }
        guard let voiceprint = Voiceprint(model: embedder.model, samples: enrolled, enrolledAt: Date()) else { throw EvalFailure.noEnrollment }

        let done = Set(((try? String(contentsOf: out, encoding: .utf8)) ?? "").split(separator: "\n").compactMap { line in
            (try? JSONDecoder().decode(ListenEvalObservation.self, from: Data(line.utf8)))?.clip.id
        })
        if !FileManager.default.fileExists(atPath: out.path) {
            FileManager.default.createFile(atPath: out.path, contents: nil)
        }
        let handle = try FileHandle(forWritingTo: out)
        try handle.seekToEnd()
        let lineEncoder = JSONEncoder()
        lineEncoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]

        let pending = clips.filter { $0.purpose != .enrollment && !done.contains($0.id) }
        for (index, clip) in pending.enumerated() {
            let buffers = try Audio.chunks(URL(fileURLWithPath: clip.file))
            var transcripts: [ListenEvalTranscript] = []
            for engine in engines {
                for locale in Self.locales[clip.language] ?? ["en-US"] {
                    if let transcript = try? await transcribe(buffers, engine: engine, locale: locale, farField: clip.placement != .hand && clip.placement != .airpods) {
                        transcripts.append(transcript)
                    }
                }
            }
            let samples = Audio.monoSamples(buffers)
            let primary = transcripts.first
            let span = primary?.speechSpan
            let spoken = span.map { range in
                Array(samples[min(samples.count, Int(range.lowerBound * Audio.rate))..<min(samples.count, Int((range.upperBound * Audio.rate).rounded(.up)))])
            } ?? samples
            let speech = spoken.count >= Int(FluidSpeakerEmbedder.minimumSeconds * Audio.rate) ? spoken : samples
            let embedding = try? await embedder.embedding(samples: speech, sampleRate: Audio.rate)
            let score = embedding.flatMap { voiceprint.score($0, model: embedder.model) }
            let loudness = SpeechLevel.dbfs(samples: speech, sampleRate: Audio.rate).map(VoiceScore.loudness(dbfs:))
            let call: ListenEvalCall? = [.command, .bystander, .tvMention, .ownerMention].contains(clip.purpose)
                ? ListenEvalReplay.call(names: names, pieces: primary?.pieces ?? [])
                : nil
            let observation = ListenEvalObservation(clip: clip, transcripts: transcripts, speakerModel: embedder.model, speakerScore: score, loudnessScore: loudness, call: call)
            try handle.write(contentsOf: lineEncoder.encode(observation) + Data("\n".utf8))
            print("[\(index + 1)/\(pending.count)] \(clip.id) score=\(score.map(String.init) ?? "-") text=\(primary?.text ?? "")")
        }
        try handle.close()
    }

    func transcribe(_ buffers: [AVAudioPCMBuffer], engine: SpeechEngine, locale: String, farField: Bool) async throws -> ListenEvalTranscript {
        let started = Date()
        let pipeline = try await SpeechPipeline.make(preferred: Locale(identifier: locale), sensitivity: .medium, engine: engine, farField: farField)
        let box = PieceBox()
        try await pipeline.start { piece in box.add(piece) }
        for buffer in buffers { pipeline.feed(buffer) }
        await pipeline.finish()
        return ListenEvalTranscript(
            engine: engine.rawValue,
            locale: pipeline.locale.identifier(.bcp47),
            pieces: box.all,
            processingSeconds: Date().timeIntervalSince(started)
        )
    }
}
#else
@main
struct ListenEval {
    static func main() {}
}
#endif
