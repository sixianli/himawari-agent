#if os(iOS) && canImport(HomeKit)
import Foundation
import HimawariCore
import HomeKit

@MainActor
final class HomeLoader: NSObject, HMHomeManagerDelegate {
    private var manager: HMHomeManager?
    private var waiting: [UUID: CheckedContinuation<HMHomeManager?, Never>] = [:]
    private var loaded = false
    static let loadLimit: Duration = .seconds(30)
    static let askedKey = "himawari.home.asked"

    var asked: Bool {
        get { UserDefaults.standard.bool(forKey: Self.askedKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.askedKey) }
    }

    func homes() async -> HMHomeManager? {
        if let manager, loaded { return manager }
        let ticket = UUID()
        let manager = current
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: Self.loadLimit)
            self?.waiting.removeValue(forKey: ticket)?.resume(returning: nil)
        }
        return await withCheckedContinuation { continuation in
            if loaded {
                continuation.resume(returning: manager)
            } else {
                waiting[ticket] = continuation
            }
        }
    }

    private var current: HMHomeManager {
        if let manager { return manager }
        let created = HMHomeManager()
        created.delegate = self
        manager = created
        return created
    }

    var status: HMHomeManagerAuthorizationStatus? {
        guard manager != nil || asked else { return nil }
        return current.authorizationStatus
    }

    nonisolated func homeManagerDidUpdateHomes(_ manager: HMHomeManager) {
        Task { @MainActor in self.finish(manager) }
    }

    nonisolated func homeManager(_ manager: HMHomeManager, didUpdate status: HMHomeManagerAuthorizationStatus) {
        Task { @MainActor in
            if status.contains(.determined) { self.finish(manager) }
        }
    }

    private func finish(_ manager: HMHomeManager) {
        loaded = true
        let pending = waiting.values
        waiting.removeAll()
        pending.forEach { $0.resume(returning: manager) }
    }
}

struct HomeUnavailable: Error {}

public struct HomePermission: DevicePermission {
    let loader: HomeLoader

    public var id: String { "home" }
    public var name: LocalizedLine { line("家庭", "Home", "ホーム") }
    public var settingsPath: LocalizedLine { SettingsPath.home }
    public var purpose: LocalizedLine {
        line("你问家里的灯、空调、门锁现在怎样，或者让 Himawari 开关它们时，它用这台 iPhone 的“家庭”去读和控制。门锁、车库门这类每次都要你本人点头。",
             "When you ask how the lights, AC or locks at home are, or ask Himawari to switch them, it reads and controls them through this iPhone's Home. Locks and garage doors always need you to approve in person.",
             "家の照明・エアコン・鍵の状態を聞いたり操作を頼んだりすると、この iPhone の「ホーム」で読み取りと操作をします。鍵やガレージは毎回あなた本人の承認が必要です。")
    }

    public func status() async -> DevicePermissionStatus {
        guard let status = await loader.status else { return .notDetermined }
        if status.contains(.authorized) { return .authorized }
        if status.contains(.restricted) { return .unavailable }
        if status.contains(.determined) { return .denied }
        return .notDetermined
    }

    public func request() async -> DevicePermissionStatus {
        await MainActor.run { loader.asked = true }
        _ = await loader.homes()
        return await status()
    }
}

public final class HomeActions: DeviceActionHandler, @unchecked Sendable {
    public let names = ["home.control", "home.read"]
    public let readOnly: Set<String> = ["home.read"]
    private let loader: HomeLoader
    public let permission: DevicePermission

    @MainActor
    public init() {
        loader = HomeLoader()
        permission = HomePermission(loader: loader)
    }

    struct Control {
        let key: String
        let target: String
        let current: String
        let encode: (DeviceActionValue) -> Any?
    }

    static var controls: [Control] {
        [
            Control(key: "on", target: HMCharacteristicTypePowerState, current: HMCharacteristicTypePowerState) { $0.bool },
            Control(key: "level", target: HMCharacteristicTypeBrightness, current: HMCharacteristicTypeBrightness) { $0.integer },
            Control(key: "level", target: HMCharacteristicTypeTargetPosition, current: HMCharacteristicTypeCurrentPosition) { $0.integer },
            Control(key: "targetTemperature", target: HMCharacteristicTypeTargetTemperature, current: HMCharacteristicTypeTargetTemperature) { $0.number },
            Control(key: "locked", target: HMCharacteristicTypeTargetLockMechanismState, current: HMCharacteristicTypeCurrentLockMechanismState) { value in
                value.bool.map { $0 ? HMCharacteristicValueLockMechanismState.secured.rawValue : HMCharacteristicValueLockMechanismState.unsecured.rawValue }
            },
        ]
    }

    public func snapshot(_ delivery: DeviceActionDelivery) async throws -> JSONObject? {
        guard let accessory = try await accessory(delivery) else { return nil }
        return await Self.state(accessory)
    }

    public func perform(_ delivery: DeviceActionDelivery) async throws -> JSONObject {
        if delivery.action == "home.read" { return try await read(delivery) }
        guard let accessory = try await accessory(delivery) else { throw DeviceActionFailure(.targetMissing) }
        guard accessory.isReachable else { throw DeviceActionFailure(.targetMissing) }
        var writes: [(key: String, value: DeviceActionValue, characteristic: HMCharacteristic, encoded: Any)] = []
        for (key, value) in delivery.arguments.sorted(by: { $0.key < $1.key }) where key != "accessoryId" {
            guard let control = Self.controls.first(where: { $0.key == key && Self.characteristic(accessory, $0.target) != nil }),
                  let characteristic = Self.characteristic(accessory, control.target),
                  let encoded = control.encode(value) else {
                throw DeviceActionFailure(.cannotChange(line("这个配件的“\(key)”", "this accessory's \"\(key)\"", "このアクセサリの「\(key)」")))
            }
            writes.append((key, value, characteristic, encoded))
        }
        var wrote: JSONObject = [:]
        for write in writes {
            try await write.characteristic.writeValue(write.encoded)
            wrote[write.key] = write.value
        }
        return ["accessoryId": .string(accessory.uniqueIdentifier.uuidString), "wrote": .object(wrote)]
    }

    public func readBack(_ delivery: DeviceActionDelivery, made: JSONObject?) async throws -> DeviceActionReading {
        guard let accessory = try await accessory(delivery) else { return .differs(["absent": .bool(true)]) }
        let state = await Self.state(accessory)
        for (key, wanted) in delivery.arguments where key != "accessoryId" {
            guard let control = Self.controls.first(where: { $0.key == key && Self.characteristic(accessory, $0.target) != nil }),
                  let current = Self.characteristic(accessory, control.current) else { return .unreadable }
            guard (try? await current.readValue()) != nil else { return .unreadable }
            let now = current.value
            switch key {
            case "locked":
                let secured = (now as? Int) == HMCharacteristicValueLockMechanismState.secured.rawValue
                let unsecured = (now as? Int) == HMCharacteristicValueLockMechanismState.unsecured.rawValue
                if !secured && !unsecured { return .unreadable }
                if secured != (wanted.bool ?? false) { return .differs(state) }
            case "on":
                if (now as? Bool) != wanted.bool { return .differs(state) }
            default:
                guard let number = (now as? NSNumber)?.doubleValue, let target = wanted.number else { return .unreadable }
                if abs(number - target) > 0.5 { return .differs(state) }
            }
        }
        return .matches(state)
    }

    private func read(_ delivery: DeviceActionDelivery) async throws -> JSONObject {
        guard let manager = await loader.homes() else { throw HomeUnavailable() }
        let args = delivery.args
        let wantedId = try args.optionalString("accessoryId")
        let wantedRoom = try args.optionalString("room")
        let accessories = await MainActor.run { manager.homes.flatMap(\.accessories) }
        let chosen = accessories.filter { accessory in
            if let wantedId { return accessory.uniqueIdentifier.uuidString == wantedId }
            if let wantedRoom { return accessory.room?.name == wantedRoom }
            return true
        }
        if wantedId != nil, chosen.isEmpty { throw DeviceActionFailure(.targetMissing) }
        var items: [JSONObject] = []
        for accessory in chosen { items.append(await Self.state(accessory)) }
        return DeviceActionListing.fit(items, as: "accessories", within: delivery.resultMaximumBytes)
    }

    private func accessory(_ delivery: DeviceActionDelivery) async throws -> HMAccessory? {
        let id = try delivery.args.string("accessoryId")
        guard let manager = await loader.homes() else { throw HomeUnavailable() }
        return await MainActor.run { manager.homes.flatMap(\.accessories).first { $0.uniqueIdentifier.uuidString == id } }
    }

    static let categories: [String: String] = [
        HMAccessoryCategoryTypeAirPurifier: "air_purifier",
        HMAccessoryCategoryTypeFan: "fan",
        HMAccessoryCategoryTypeAirHumidifier: "humidifier",
        HMAccessoryCategoryTypeAirDehumidifier: "humidifier",
        HMAccessoryCategoryTypeLightbulb: "light",
        HMAccessoryCategoryTypeOutlet: "outlet",
        HMAccessoryCategoryTypeSwitch: "switch",
        HMAccessoryCategoryTypeProgrammableSwitch: "switch",
        HMAccessoryCategoryTypeTelevision: "television",
        HMAccessoryCategoryTypeThermostat: "thermostat",
        HMAccessoryCategoryTypeAirConditioner: "thermostat",
        HMAccessoryCategoryTypeAirHeater: "thermostat",
        HMAccessoryCategoryTypeWindowCovering: "window_covering",
        HMAccessoryCategoryTypeDoorLock: "door_lock",
        HMAccessoryCategoryTypeGarageDoorOpener: "garage_door",
        HMAccessoryCategoryTypeDoor: "door",
        HMAccessoryCategoryTypeWindow: "window",
        HMAccessoryCategoryTypeSecuritySystem: "security_system",
        HMAccessoryCategoryTypeIPCamera: "camera",
        HMAccessoryCategoryTypeVideoDoorbell: "doorbell",
        HMAccessoryCategoryTypeSensor: "sensor",
        HMAccessoryCategoryTypeBridge: "bridge",
    ]

    static func category(_ type: String) -> String {
        categories[type] ?? "other"
    }

    static func characteristic(_ accessory: HMAccessory, _ type: String) -> HMCharacteristic? {
        accessory.services.flatMap(\.characteristics).first { $0.characteristicType == type }
    }

    static func state(_ accessory: HMAccessory) async -> JSONObject {
        var values: JSONObject = [:]
        let readable: [(String, String)] = [
            ("on", HMCharacteristicTypePowerState),
            ("level", HMCharacteristicTypeBrightness),
            ("position", HMCharacteristicTypeCurrentPosition),
            ("temperature", HMCharacteristicTypeCurrentTemperature),
            ("targetTemperature", HMCharacteristicTypeTargetTemperature),
            ("locked", HMCharacteristicTypeCurrentLockMechanismState),
        ]
        for (key, type) in readable {
            guard let characteristic = characteristic(accessory, type),
                  (try? await characteristic.readValue()) != nil else { continue }
            switch characteristic.value {
            case let flag as Bool: values[key] = .bool(flag)
            case let number as NSNumber:
                if key == "locked" {
                    values[key] = .bool(number.intValue == HMCharacteristicValueLockMechanismState.secured.rawValue)
                } else {
                    values[key] = .number(number.doubleValue)
                }
            default: break
            }
        }
        return [
            "accessoryId": .string(accessory.uniqueIdentifier.uuidString),
            "name": .string(accessory.name),
            "room": .string(accessory.room?.name ?? ""),
            "reachable": .bool(accessory.isReachable),
            "category": .string(category(accessory.category.categoryType)),
            "state": .object(values),
        ]
    }
}
#endif
