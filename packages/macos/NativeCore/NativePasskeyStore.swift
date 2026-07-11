import CryptoKit
import Foundation
import Security

public struct NativePasskeyRecord: Codable, Sendable {
    public let relyingParty: String
    public let userName: String
    public let userHandle: Data
    public let credentialID: Data

    public init(relyingParty: String, userName: String, userHandle: Data, credentialID: Data) {
        self.relyingParty = relyingParty
        self.userName = userName
        self.userHandle = userHandle
        self.credentialID = credentialID
    }
}

public enum NativePasskeyStoreError: Error {
    case keyGenerationFailed
    case duplicateCredential
    case credentialNotFound
    case randomGenerationFailed(OSStatus)
    case keychain(OSStatus)
}

public final class NativePasskeyStore: @unchecked Sendable {
    private let service = "me.ch5.auth.dev.passkeys.records"
    private let keyService = "me.ch5.auth.dev.passkeys.signing"
    private let pendingIndexKey = "NativePasskeyPendingCredentialIDs"
    private let synchronized: Bool
#if DEBUG && CH5_PASSKEY_TEST_VERIFICATION_INJECTION
    private let memory: NativePasskeyMemoryStore?
#endif

    public convenience init() {
        self.init(synchronized: true)
    }

    init(synchronized: Bool) {
        self.synchronized = synchronized
#if DEBUG && CH5_PASSKEY_TEST_VERIFICATION_INJECTION
        self.memory = nil
#endif
    }

#if DEBUG && CH5_PASSKEY_TEST_VERIFICATION_INJECTION
    init(testingInMemory: Void) {
        self.synchronized = false
        self.memory = NativePasskeyMemoryStore()
    }
#endif

    public func create(relyingParty: String, userName: String, userHandle: Data) throws -> NativePasskeyRecord {
        let credentialID = try randomBytes(count: 32)
        let record = NativePasskeyRecord(
            relyingParty: relyingParty,
            userName: userName,
            userHandle: userHandle,
            credentialID: credentialID
        )
#if DEBUG && CH5_PASSKEY_TEST_VERIFICATION_INJECTION
        if let memory {
            return try memory.create(record)
        }
#endif
        try createSigningKey(credentialID: credentialID)
        do {
            try save(record)
        } catch {
            deleteSigningKey(credentialID: credentialID)
            throw error
        }
        var pending = UserDefaults.standard.stringArray(forKey: pendingIndexKey) ?? []
        pending.append(record.credentialID.base64EncodedString())
        UserDefaults.standard.set(pending, forKey: pendingIndexKey)
        return record
    }

    public func commit(_ record: NativePasskeyRecord) {
#if DEBUG && CH5_PASSKEY_TEST_VERIFICATION_INJECTION
        if let memory {
            memory.commit(record)
            return
        }
#endif
        let encoded = record.credentialID.base64EncodedString()
        let pending = (UserDefaults.standard.stringArray(forKey: pendingIndexKey) ?? []).filter { $0 != encoded }
        UserDefaults.standard.set(pending, forKey: pendingIndexKey)
    }

    public func pendingRecords() throws -> [NativePasskeyRecord] {
#if DEBUG && CH5_PASSKEY_TEST_VERIFICATION_INJECTION
        if let memory { return memory.pendingRecords() }
#endif
        let pending = UserDefaults.standard.stringArray(forKey: pendingIndexKey) ?? []
        return try pending.compactMap { account in
            guard let credentialID = Data(base64Encoded: account) else { return nil }
            do {
                return try load(credentialID: credentialID)
            } catch NativePasskeyStoreError.credentialNotFound {
                return nil
            }
        }
    }

    public func load(credentialID: Data) throws -> NativePasskeyRecord {
#if DEBUG && CH5_PASSKEY_TEST_VERIFICATION_INJECTION
        if let memory { return try memory.load(credentialID: credentialID) }
#endif
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: credentialID.base64EncodedString(),
            kSecAttrSynchronizable as String: synchronized,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { throw NativePasskeyStoreError.credentialNotFound }
        guard status == errSecSuccess, let data = result as? Data else { throw NativePasskeyStoreError.keychain(status) }
        return try JSONDecoder().decode(NativePasskeyRecord.self, from: data)
    }

    func publicKey(for record: NativePasskeyRecord) throws -> P256.Signing.PublicKey {
#if DEBUG && CH5_PASSKEY_TEST_VERIFICATION_INJECTION
        if let memory { return try memory.signingKey(credentialID: record.credentialID).publicKey }
#endif
        return try signingKey(credentialID: record.credentialID).publicKey
    }

    func signature(for record: NativePasskeyRecord, data: Data) throws -> Data {
#if DEBUG && CH5_PASSKEY_TEST_VERIFICATION_INJECTION
        if let memory {
            return try memory.signingKey(credentialID: record.credentialID).signature(for: data).derRepresentation
        }
#endif
        let key = try signingKey(credentialID: record.credentialID)
        return try key.signature(for: data).derRepresentation
    }

    public func delete(credentialID: Data) throws {
#if DEBUG && CH5_PASSKEY_TEST_VERIFICATION_INJECTION
        if let memory {
            memory.delete(credentialID: credentialID)
            return
        }
#endif
        let account = credentialID.base64EncodedString()
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: synchronized,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw NativePasskeyStoreError.keychain(status)
        }
        let pending = (UserDefaults.standard.stringArray(forKey: pendingIndexKey) ?? []).filter { $0 != account }
        UserDefaults.standard.set(pending, forKey: pendingIndexKey)
        deleteSigningKey(credentialID: credentialID)
    }

    private func save(_ record: NativePasskeyRecord) throws {
        let encoded = try JSONEncoder().encode(record)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: record.credentialID.base64EncodedString(),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
            kSecAttrSynchronizable as String: synchronized,
            kSecValueData as String: encoded,
        ]
        let status = SecItemAdd(query as CFDictionary, nil)
        if status == errSecDuplicateItem { throw NativePasskeyStoreError.duplicateCredential }
        guard status == errSecSuccess else { throw NativePasskeyStoreError.keychain(status) }
    }

    private func createSigningKey(credentialID: Data) throws {
        let key = P256.Signing.PrivateKey()
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keyService,
            kSecAttrAccount as String: credentialID.base64EncodedString(),
            kSecAttrSynchronizable as String: synchronized,
            kSecValueData as String: key.rawRepresentation,
        ]
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlocked
        let status = SecItemAdd(query as CFDictionary, nil)
        if status == errSecDuplicateItem { throw NativePasskeyStoreError.duplicateCredential }
        guard status == errSecSuccess else { throw NativePasskeyStoreError.keychain(status) }
    }

    private func signingKey(credentialID: Data) throws -> P256.Signing.PrivateKey {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keyService,
            kSecAttrAccount as String: credentialID.base64EncodedString(),
            kSecAttrSynchronizable as String: synchronized,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { throw NativePasskeyStoreError.credentialNotFound }
        guard status == errSecSuccess, let keyData = result as? Data else {
            throw NativePasskeyStoreError.keychain(status)
        }
        return try P256.Signing.PrivateKey(rawRepresentation: keyData)
    }

    private func deleteSigningKey(credentialID: Data) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keyService,
            kSecAttrAccount as String: credentialID.base64EncodedString(),
            kSecAttrSynchronizable as String: synchronized,
        ]
        SecItemDelete(query as CFDictionary)
    }

    private func randomBytes(count: Int) throws -> Data {
        var bytes = Data(count: count)
        let status = bytes.withUnsafeMutableBytes { buffer in
            SecRandomCopyBytes(kSecRandomDefault, count, buffer.baseAddress!)
        }
        guard status == errSecSuccess else { throw NativePasskeyStoreError.randomGenerationFailed(status) }
        return bytes
    }
}

#if DEBUG && CH5_PASSKEY_TEST_VERIFICATION_INJECTION
private final class NativePasskeyMemoryStore: @unchecked Sendable {
    private let lock = NSLock()
    private var records: [Data: NativePasskeyRecord] = [:]
    private var signingKeys: [Data: P256.Signing.PrivateKey] = [:]
    private var pending: Set<Data> = []

    func create(_ record: NativePasskeyRecord) throws -> NativePasskeyRecord {
        try lock.withLock {
            guard records[record.credentialID] == nil else { throw NativePasskeyStoreError.duplicateCredential }
            records[record.credentialID] = record
            signingKeys[record.credentialID] = P256.Signing.PrivateKey()
            pending.insert(record.credentialID)
            return record
        }
    }

    func commit(_ record: NativePasskeyRecord) {
        lock.withLock { _ = pending.remove(record.credentialID) }
    }

    func pendingRecords() -> [NativePasskeyRecord] {
        lock.withLock { pending.compactMap { records[$0] } }
    }

    func load(credentialID: Data) throws -> NativePasskeyRecord {
        try lock.withLock {
            guard let record = records[credentialID] else { throw NativePasskeyStoreError.credentialNotFound }
            return record
        }
    }

    func signingKey(credentialID: Data) throws -> P256.Signing.PrivateKey {
        try lock.withLock {
            guard let key = signingKeys[credentialID] else { throw NativePasskeyStoreError.credentialNotFound }
            return key
        }
    }

    func delete(credentialID: Data) {
        lock.withLock {
            records.removeValue(forKey: credentialID)
            signingKeys.removeValue(forKey: credentialID)
            pending.remove(credentialID)
        }
    }
}
#endif
