#if os(iOS)
import Contacts
import Foundation
import HimawariCore

@MainActor
public final class ContactsCollector: SenseCollector {
    public let item = SenseItem.contacts
    private let store = CNContactStore()
    private var sink: SenseSink?
    private var observer: NSObjectProtocol?

    public init() {}

    public func authorization() async -> SenseAuthorization {
        Self.map(CNContactStore.authorizationStatus(for: .contacts))
    }

    public func requestAuthorization() async -> SenseAuthorization {
        _ = try? await store.requestAccess(for: .contacts)
        return Self.map(CNContactStore.authorizationStatus(for: .contacts))
    }

    public func start(_ sink: SenseSink) {
        self.sink = sink
        observer = NotificationCenter.default.addObserver(forName: .CNContactStoreDidChange, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.sync() }
        }
        Task { await sync() }
    }

    public func stop() {
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        sink = nil
    }

    func sync() async {
        guard let sink, let kind = item.mirrorKind else { return }
        let entries = await Task.detached(priority: .utility) { Self.entries() }.value
        await sink.mirror(kind: kind, entries: entries)
    }

    nonisolated static func entries() -> [MirrorEntry] {
        let keys: [CNKeyDescriptor] = [
            CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
            CNContactOrganizationNameKey as CNKeyDescriptor,
            CNContactPhoneNumbersKey as CNKeyDescriptor,
            CNContactEmailAddressesKey as CNKeyDescriptor,
            CNContactBirthdayKey as CNKeyDescriptor,
        ]
        var result: [MirrorEntry] = []
        let request = CNContactFetchRequest(keysToFetch: keys)
        request.sortOrder = .none
        try? CNContactStore().enumerateContacts(with: request) { contact, _ in
            let organization = contact.organizationName
            let name = CNContactFormatter.string(from: contact, style: .fullName) ?? ""
            let display = name.isEmpty ? organization : name
            guard !display.isEmpty else { return }
            var data: [String: JSONScalar] = ["name": .string(display)]
            if !organization.isEmpty { data["organization"] = .string(organization) }
            let phones = contact.phoneNumbers.map(\.value.stringValue).filter { !$0.isEmpty }
            if !phones.isEmpty { data["phones"] = .string(phones.joined(separator: ", ")) }
            let emails = contact.emailAddresses.map { String($0.value) }.filter { !$0.isEmpty }
            if !emails.isEmpty { data["emails"] = .string(emails.joined(separator: ", ")) }
            if let birthday = contact.birthday, let month = birthday.month, let day = birthday.day {
                let year = birthday.year.map { String(format: "%04d", $0) } ?? "-"
                data["birthday"] = .string("\(year)-\(String(format: "%02d", month))-\(String(format: "%02d", day))")
            }
            result.append(MirrorEntry(externalId: String(contact.identifier.prefix(256)), data: data))
        }
        return result
    }

    static func map(_ status: CNAuthorizationStatus) -> SenseAuthorization {
        switch status {
        case .notDetermined: .notAsked
        case .authorized: .allowed
        case .limited: .limited
        case .restricted: .restricted
        case .denied: .denied
        @unknown default: .denied
        }
    }
}
#endif
