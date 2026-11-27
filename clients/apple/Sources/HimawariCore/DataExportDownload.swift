import Foundation

extension DeviceAPI {
    public func dataExportArchive(exportId: String) async throws -> Data {
        try await http.send(
            DeviceRequest(method: "GET", path: "data-export/archive", query: [URLQueryItem(name: "exportId", value: exportId)])
        )
    }
}
