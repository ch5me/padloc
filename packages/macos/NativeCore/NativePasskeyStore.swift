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

    public convenience init() {
        self.init(synchronized: true)
    }

    init(synchronized: Bool) {
        self.synchronized = synchronized
    }

    public func create(relyingParty: String, userName: String, userHandle: Data) throws -> NativePasskeyRecord {
        let credentialID = try randomBytes(count: 32)
        let record = NativePasskeyRecord(
            relyingParty: relyingParty,
            userName: userName,
            userHandle: userHandle,
            credentialID: credentialID
        )
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
        let encoded = record.credentialID.base64EncodedString()
        let pending = (UserDefaults.standard.stringArray(forKey: pendingIndexKey) ?? []).filter { $0 != encoded }
        UserDefaults.standard.set(pending, forKey: pendingIndexKey)
    }

    public func pendingRecords() throws -> [NativePasskeyRecord] {
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
        try signingKey(credentialID: record.credentialID).publicKey
    }

    func signature(for record: NativePasskeyRecord, data: Data) throws -> Data {
        let key = try signingKey(credentialID: record.credentialID)
        return try key.signature(for: data).derRepresentation
    }

    public func delete(credentialID: Data) throws {
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
