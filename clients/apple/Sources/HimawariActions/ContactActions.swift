#if canImport(Contacts)
import Contacts
import Foundation
import HimawariCore

public final class ContactActions: DeviceActionHandler, @unchecked Sendable {
    public let names = ["contact.update"]
    private let store: CNContactStore
    public let permission: DevicePermission

    public init(store: CNContactStore = CNContactStore()) {
        self.store = store
        permission = ContactsPermission()
    }

    static let notes = line("联系人的备注", "contact notes", "連絡先のメモ")

    private static var keys: [CNKeyDescriptor] {
        [
            CNContactGivenNameKey as CNKeyDescriptor,
            CNContactFamilyNameKey as CNKeyDescriptor,
            CNContactPhoneNumbersKey as CNKeyDescriptor,
            CNContactEmailAddressesKey as CNKeyDescriptor,
            CNContactOrganizationNameKey as CNKeyDescriptor,
        ]
    }

    public func snapshot(_ delivery: DeviceActionDelivery) async throws -> JSONObject? {
        try contact(delivery).map(Self.describe)
    }

    public func perform(_ delivery: DeviceActionDelivery) async throws -> JSONObject {
        let args = delivery.args
        if try args.optionalString("notes") != nil { throw DeviceActionFailure(.cannotChange(Self.notes)) }
        guard let current = try contact(delivery), let contact = current.mutableCopy() as? CNMutableContact else {
            throw DeviceActionFailure(.targetMissing)
        }
        if let given = try args.optionalString("givenName") { contact.givenName = given }
        if let family = try args.optionalString("familyName") { contact.familyName = family }
        if let organization = try args.optionalString("organization") { contact.organizationName = organization }
        if let phones = try args.optionalStrings("phones") {
            let existing = contact.phoneNumbers
            contact.phoneNumbers = phones.map { number in
                existing.first { $0.value.stringValue == number }
                    ?? CNLabeledValue(label: CNLabelPhoneNumberMobile, value: CNPhoneNumber(stringValue: number))
            }
        }
        if let emails = try args.optionalStrings("emails") {
            let existing = contact.emailAddresses
            contact.emailAddresses = emails.map { email in
                existing.first { ($0.value as String) == email } ?? CNLabeledValue(label: CNLabelOther, value: email as NSString)
            }
        }
        let request = CNSaveRequest()
        request.update(contact)
        try store.execute(request)
        return Self.describe(contact)
    }

    public func readBack(_ delivery: DeviceActionDelivery, made: JSONObject?) async throws -> DeviceActionReading {
        guard let contact = try contact(delivery) else { return .differs(["absent": .bool(true)]) }
        let found = Self.describe(contact)
        let args = delivery.args
        for key in ["givenName", "familyName", "organization"] {
            if let wanted = try args.optionalString(key), found[key]?.string != wanted { return .differs(found) }
        }
        for key in ["phones", "emails"] {
            if let wanted = try args.optionalStrings(key), found[key]?.strings != wanted { return .differs(found) }
        }
        return .matches(found)
    }

    private func contact(_ delivery: DeviceActionDelivery) throws -> CNContact? {
        do {
            return try store.unifiedContact(withIdentifier: try delivery.args.string("contactId"), keysToFetch: Self.keys)
        } catch let error as CNError where error.code == .recordDoesNotExist {
            return nil
        }
    }

    static func describe(_ contact: CNContact) -> JSONObject {
        [
            "contactId": .string(contact.identifier),
            "givenName": .string(contact.givenName),
            "familyName": .string(contact.familyName),
            "organization": .string(contact.organizationName),
            "phones": .array(contact.phoneNumbers.map { .string($0.value.stringValue) }),
            "emails": .array(contact.emailAddresses.map { .string($0.value as String) }),
        ]
    }
}
#endif
