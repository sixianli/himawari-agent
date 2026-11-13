import Foundation
import HimawariCore

package enum ListenResources {
    package static func evalKit() throws -> ListenEvalKit {
        guard let url = Bundle.module.url(forResource: "listen-eval-kit", withExtension: "json") else { throw CocoaError(.fileNoSuchFile) }
        return try ListenEvalKit.decode(Data(contentsOf: url))
    }

    package static func names() -> [String] {
        struct File: Decodable { let names: [String] }
        guard
            let url = Bundle.module.url(forResource: "listen-names", withExtension: "json"),
            let data = try? Data(contentsOf: url),
            let file = try? JSONDecoder().decode(File.self, from: data)
        else { return [] }
        return file.names
    }
}
