import CryptoKit
import Foundation

public struct NativeRegistrationResult: Sendable {
    public let record: NativePasskeyRecord
    public let authenticatorData: Data
    public let attestationObject: Data
}

public struct NativeAssertionResult: Sendable {
    public let record: NativePasskeyRecord
    public let authenticatorData: Data
    public let signature: Data
}

public enum NativePasskeyBrokerError: Error, Equatable {
    case relyingPartyMismatch
    case invalidVerification
}

/// Narrow signing boundary used by the credential-provider controller.
/// Private key reconstruction and use remain inside this broker and are never
/// returned to the controller or AuthenticationServices response objects.
public final class NativePasskeyBroker: @unchecked Sendable {
    private let store: NativePasskeyStore

    public init(store: NativePasskeyStore = NativePasskeyStore()) {
        self.store = store
    }

    public func register(
        relyingParty: String,
        userName: String,
        userHandle: Data,
        clientDataHash: Data,
        verification: NativeUserVerification
    ) throws -> NativeRegistrationResult {
        let binding = NativeUserVerificationBinding.registration(
            relyingParty: relyingParty,
            userHandle: userHandle,
            clientDataHash: clientDataHash
        )
        guard verification.consume(binding: binding) else { throw NativePasskeyBrokerError.invalidVerification }
        let record = try store.create(
            relyingParty: relyingParty,
            userName: userName,
            userHandle: userHandle
        )
        do {
            let publicKey = try store.publicKey(for: record)
            let authenticatorData = try PasskeyCodec.registrationAuthenticatorData(
                relyingParty: record.relyingParty,
                credentialID: record.credentialID,
                publicKey: publicKey,
                userVerified: true
            )
            return NativeRegistrationResult(
                record: record,
                authenticatorData: authenticatorData,
                attestationObject: PasskeyCodec.noneAttestationObject(authenticatorData: authenticatorData)
            )
        } catch {
            try? store.delete(credentialID: record.credentialID)
            throw error
        }
    }

    public func commit(_ registration: NativeRegistrationResult) {
        store.commit(registration.record)
    }

    public func discard(_ registration: NativeRegistrationResult) {
        try? store.delete(credentialID: registration.record.credentialID)
    }

    public func pendingRegistrations() throws -> [NativePasskeyRecord] {
        try store.pendingRecords()
    }

    public func discardPendingRegistration(_ record: NativePasskeyRecord) {
        try? store.delete(credentialID: record.credentialID)
    }

    public func assert(
        credentialID: Data,
        relyingParty: String,
        clientDataHash: Data,
        verification: NativeUserVerification
    ) throws -> NativeAssertionResult {
        let binding = NativeUserVerificationBinding.assertion(
            relyingParty: relyingParty,
            credentialID: credentialID,
            clientDataHash: clientDataHash
        )
        guard verification.consume(binding: binding) else { throw NativePasskeyBrokerError.invalidVerification }
        let record = try store.load(credentialID: credentialID)
        guard record.relyingParty == relyingParty else { throw NativePasskeyBrokerError.relyingPartyMismatch }
        let authenticatorData = PasskeyCodec.assertionAuthenticatorData(
            relyingParty: record.relyingParty,
            userVerified: true
        )
        var signedData = authenticatorData
        signedData.append(clientDataHash)
        let signature = try store.signature(for: record, data: signedData)
        return NativeAssertionResult(record: record, authenticatorData: authenticatorData, signature: signature)
    }
}
