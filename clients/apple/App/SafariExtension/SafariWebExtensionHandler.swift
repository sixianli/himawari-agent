import Foundation
import HimawariShare
import SafariServices

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let payload = (item?.userInfo?[SFExtensionMessageKey] as? [String: Any]).flatMap { try? JSONSerialization.data(withJSONObject: $0) } ?? Data()
        nonisolated(unsafe) let context = context
        Task { @MainActor in
            let message = (try? JSONSerialization.jsonObject(with: payload)) as? [String: Any] ?? [:]
            let reply = await SafariBridge.reply(to: message, desk: HandoverExtension.desk())
            let response = NSExtensionItem()
            response.userInfo = [SFExtensionMessageKey: reply]
            context.completeRequest(returningItems: [response], completionHandler: nil)
        }
    }
}
