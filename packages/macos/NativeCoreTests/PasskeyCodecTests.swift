import CryptoKit
import XCTest
@testable import CH5AuthNativeCore

final class PasskeyCodecTests: XCTestCase {
#if DEBUG && CH5_PASSKEY_TEST_VERIFICATION_INJECTION
    private func makeTestStore() -> NativePasskeyStore {
        NativePasskeyStore(testingInMemory: ())
    }
#else
    private func makeTestStore() -> NativePasskeyStore {
        NativePasskeyStore(synchronized: false)
    }
#endif
#if DEBUG && CH5_PASSKEY_TEST_VERIFICATION_INJECTION
    func testTestOnlyVerificationInjectionIsSyntheticAndStillClientHashBound() throws {
        let broker = NativePasskeyBroker(store: makeTestStore())
        let clientDataHash = PasskeyCodec.sha256(Data("injected-registration".utf8))
        let binding = NativeUserVerificationBinding.registration(
            relyingParty: "localhost", userHandle: Data([1]), clientDataHash: clientDataHash
        )
        _ = try broker.register(
            relyingParty: "localhost", userName: "test-only", userHandle: Data([1]),
            clientDataHash: clientDataHash,
            verification: NativeTestVerificationInjection.grant(binding: binding)
        )
        XCTAssertThrowsError(try broker.register(
            relyingParty: "localhost", userName: "wrong-hash", userHandle: Data([2]),
            clientDataHash: PasskeyCodec.sha256(Data("other".utf8)),
            verification: NativeTestVerificationInjection.grant(binding: binding)
        ))
    }
#endif
    func testRegistrationAuthenticatorDataUsesWebAuthnLayoutWithoutFalseUV() throws {
        let credentialID = Data(repeating: 0x2a, count: 32)
        let data = try PasskeyCodec.registrationAuthenticatorData(
            relyingParty: "webauthn.io",
            credentialID: credentialID,
            publicKey: P256.Signing.PrivateKey().publicKey,
            userVerified: false
        )

        XCTAssertEqual(data.prefix(32), PasskeyCodec.sha256(Data("webauthn.io".utf8)))
        XCTAssertEqual(data[32], 0x59, "UP, BE, BS, and AT must be set; UV must remain clear")
        XCTAssertEqual(data.subdata(in: 33..<37), Data(repeating: 0, count: 4))
        XCTAssertEqual(data.subdata(in: 37..<53), Data(repeating: 0, count: 16))
        XCTAssertEqual(data[53], 0)
        XCTAssertEqual(data[54], 32)
        XCTAssertEqual(data.subdata(in: 55..<87), credentialID)
        XCTAssertEqual(data[87], 0xa5, "COSE key must be a five-entry CBOR map")
    }

    func testNoneAttestationObjectContainsExpectedTopLevelFields() throws {
        let authData = try PasskeyCodec.registrationAuthenticatorData(
            relyingParty: "webauthn.io",
            credentialID: Data(repeating: 7, count: 32),
            publicKey: P256.Signing.PrivateKey().publicKey,
            userVerified: false
        )
        let object = PasskeyCodec.noneAttestationObject(authenticatorData: authData)

        XCTAssertEqual(object.first, 0xa3, "attestation object must be a three-entry CBOR map")
        XCTAssertTrue(object.range(of: Data("fmt".utf8)) != nil)
        XCTAssertTrue(object.range(of: Data("none".utf8)) != nil)
        XCTAssertTrue(object.range(of: Data("authData".utf8)) != nil)
        XCTAssertTrue(object.range(of: Data("attStmt".utf8)) != nil)
        XCTAssertTrue(object.range(of: authData) != nil)
    }

    func testAssertionAuthenticatorDataDoesNotClaimUV() {
        let data = PasskeyCodec.assertionAuthenticatorData(relyingParty: "webauthn.io", userVerified: false)

        XCTAssertEqual(data.count, 37)
        XCTAssertEqual(data[32], 0x19)
        XCTAssertEqual(data.suffix(4), Data(repeating: 0, count: 4))
    }

    func testVerifiedAuthenticatorDataClaimsUVOnlyWhenExplicitlySupplied() throws {
        let key = P256.Signing.PrivateKey()
        let registration = try PasskeyCodec.registrationAuthenticatorData(
            relyingParty: "webauthn.io",
            credentialID: Data(repeating: 1, count: 32),
            publicKey: key.publicKey,
            userVerified: true
        )
        let assertion = PasskeyCodec.assertionAuthenticatorData(relyingParty: "webauthn.io", userVerified: true)

        XCTAssertEqual(registration[32], 0x5d)
        XCTAssertEqual(assertion[32], 0x1d)
    }

    func testNativeCodecAndReloadUseSharedRPVerifier() throws {
        let rpID = "localhost"
        let origin = "http://localhost"
        let challenge = Data([11, 12, 13, 14, 15])
        let clientData = try JSONSerialization.data(withJSONObject: [
            "type": "webauthn.create",
            "challenge": base64URL(challenge),
            "origin": origin,
            "crossOrigin": false,
        ])
        let store = makeTestStore()
        let record = try store.create(
            relyingParty: rpID,
            userName: "native-contract-user",
            userHandle: Data([21, 22, 23])
        )
        defer { try? store.delete(credentialID: record.credentialID) }
        let reloaded = try store.load(credentialID: record.credentialID)
        XCTAssertEqual(reloaded.credentialID, record.credentialID)

        let publicKey = try store.publicKey(for: reloaded)
        let registrationData = try PasskeyCodec.registrationAuthenticatorData(
            relyingParty: rpID,
            credentialID: reloaded.credentialID,
            publicKey: publicKey,
            userVerified: false
        )
        let registrationVector: [String: Any] = [
            "operation": "registration",
            "rpID": rpID,
            "origin": origin,
            "challenge": base64URL(challenge),
            "clientDataJSON": base64URL(clientData),
            "credentialID": base64URL(reloaded.credentialID),
            "attestationObject": base64URL(PasskeyCodec.noneAttestationObject(authenticatorData: registrationData)),
            "requireUV": false,
        ]
        try verifyWithSharedRP(registrationVector)
        try rejectWithSharedRP(registrationVector.merging(["origin": "https://wrong.invalid"]) { _, replacement in replacement })
        try rejectWithSharedRP(registrationVector.merging(["rpID": "wrong.invalid"]) { _, replacement in replacement })
        try rejectWithSharedRP(registrationVector.merging(["credentialID": base64URL(Data(repeating: 0xff, count: 32))]) { _, replacement in replacement })
        try rejectWithSharedRP(registrationVector.merging(["attestationObject": base64URL(Data([0xff]))]) { _, replacement in replacement })

        var unsupportedAlgorithm = PasskeyCodec.noneAttestationObject(authenticatorData: registrationData)
        if let algorithmByte = unsupportedAlgorithm.firstIndex(of: 0x26) {
            unsupportedAlgorithm[algorithmByte] = 0x27
        } else {
            XCTFail("expected encoded ES256 algorithm")
        }
        try rejectWithSharedRP(registrationVector.merging(["attestationObject": base64URL(unsupportedAlgorithm)]) { _, replacement in replacement })
        try rejectWithSharedRP(registrationVector.merging(["requireUV": true]) { _, replacement in replacement })

        let assertionClientData = try JSONSerialization.data(withJSONObject: [
            "type": "webauthn.get",
            "challenge": base64URL(challenge),
            "origin": origin,
            "crossOrigin": false,
        ])
        let assertionData = PasskeyCodec.assertionAuthenticatorData(relyingParty: rpID, userVerified: false)
        var signed = assertionData
        signed.append(PasskeyCodec.sha256(assertionClientData))
        let x963 = publicKey.x963Representation
        let assertionVector: [String: Any] = [
            "operation": "assertion",
            "rpID": rpID,
            "origin": origin,
            "challenge": base64URL(challenge),
            "clientDataJSON": base64URL(assertionClientData),
            "credentialID": base64URL(reloaded.credentialID),
            "authenticatorData": base64URL(assertionData),
            "signature": base64URL(try store.signature(for: reloaded, data: signed)),
            "requireUV": false,
            "publicKeyJwk": [
                "kty": "EC",
                "crv": "P-256",
                "x": base64URL(x963.subdata(in: 1..<33)),
                "y": base64URL(x963.subdata(in: 33..<65)),
            ],
        ]
        try verifyWithSharedRP(assertionVector)
        try rejectWithSharedRP(assertionVector.merging([
            "expectedCredentialID": base64URL(Data(repeating: 0xee, count: 32)),
        ]) { _, replacement in replacement })
        try rejectWithSharedRP(assertionVector.merging(["signature": base64URL(Data([0x30, 0x01]))]) { _, replacement in replacement })
        try rejectWithSharedRP(assertionVector.merging(["requireUV": true]) { _, replacement in replacement })
    }

    private func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private func verifyWithSharedRP(_ vector: [String: Any]) throws {
        let result = try runSharedRPVerifier(vector)
        XCTAssertEqual(result.status, 0, result.output)
        XCTAssertEqual(result.output, "ok\n")
    }

    private func rejectWithSharedRP(_ vector: [String: Any]) throws {
        let result = try runSharedRPVerifier(vector)
        XCTAssertNotEqual(result.status, 0, "invalid vector unexpectedly passed")
        XCTAssertTrue(result.output.hasPrefix("verification failed:"))
    }

    private func runSharedRPVerifier(_ vector: [String: Any]) throws -> (status: Int32, output: String) {
        let testFile = URL(fileURLWithPath: #filePath)
        let repo = testFile.deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let verifier = repo.appendingPathComponent("packages/extension/test/passkey-rp/verify-vector.cjs").path
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", verifier]
        let input = Pipe()
        let output = Pipe()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = output
        try process.run()
        input.fileHandleForWriting.write(try JSONSerialization.data(withJSONObject: vector))
        try input.fileHandleForWriting.close()
        process.waitUntilExit()
        let statusText = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return (process.terminationStatus, statusText)
    }

    func testBrokerSelectsExactCredentialAcrossFiveRecordsAndRejectsCrossRP() throws {
        let store = makeTestStore()
        let broker = NativePasskeyBroker(store: store)
        let registrations = try (0..<5).map { index in
            let userHandle = Data([UInt8(index + 1)])
            let clientDataHash = PasskeyCodec.sha256(Data("registration-\(index)".utf8))
            return try broker.register(
                relyingParty: "localhost",
                userName: "profile-\(index + 1)",
                userHandle: userHandle,
                clientDataHash: clientDataHash,
                verification: NativeUserVerification(binding: NativeUserVerificationBinding.registration(
                    relyingParty: "localhost", userHandle: userHandle, clientDataHash: clientDataHash
                ))
            )
        }
        defer { registrations.forEach { broker.discard($0) } }
        registrations.forEach { broker.commit($0) }

        let selected = registrations[3]
        let clientHash = PasskeyCodec.sha256(Data("five-profile-assertion".utf8))
        let assertionBinding = NativeUserVerificationBinding.assertion(
            relyingParty: "localhost",
            credentialID: selected.record.credentialID,
            clientDataHash: clientHash
        )
        let assertionVerification = NativeUserVerification(binding: assertionBinding)
        let assertion = try broker.assert(
            credentialID: selected.record.credentialID,
            relyingParty: "localhost",
            clientDataHash: clientHash,
            verification: assertionVerification
        )

        XCTAssertEqual(assertion.record.userName, "profile-4")
        XCTAssertEqual(assertion.record.userHandle, Data([4]))
        XCTAssertEqual(assertion.record.credentialID, selected.record.credentialID)
        XCTAssertThrowsError(
            try broker.assert(
                credentialID: selected.record.credentialID,
                relyingParty: "localhost",
                clientDataHash: clientHash,
                verification: assertionVerification
            )
        ) { error in
            XCTAssertEqual(error as? NativePasskeyBrokerError, .invalidVerification)
        }
        XCTAssertThrowsError(
            try broker.assert(
                credentialID: selected.record.credentialID,
                relyingParty: "wrong.invalid",
                clientDataHash: clientHash,
                verification: NativeUserVerification(binding: NativeUserVerificationBinding.assertion(
                    relyingParty: "wrong.invalid",
                    credentialID: selected.record.credentialID,
                    clientDataHash: clientHash
                ))
            )
        ) { error in
            XCTAssertTrue(error is NativePasskeyBrokerError)
        }
        XCTAssertThrowsError(
            try broker.assert(
                credentialID: Data(repeating: 0xff, count: 32),
                relyingParty: "localhost",
                clientDataHash: clientHash,
                verification: NativeUserVerification(binding: NativeUserVerificationBinding.assertion(
                    relyingParty: "localhost",
                    credentialID: Data(repeating: 0xff, count: 32),
                    clientDataHash: clientHash
                ))
            )
        )
    }

    func testBrokerRejectsMismatchedAndExpiredVerificationGrants() throws {
        let broker = NativePasskeyBroker(store: makeTestStore())
        let clientDataHash = PasskeyCodec.sha256(Data("registration-binding".utf8))
        let wrongBinding = NativeUserVerificationBinding.registration(
            relyingParty: "wrong.invalid",
            userHandle: Data([1]),
            clientDataHash: clientDataHash
        )
        XCTAssertThrowsError(try broker.register(
            relyingParty: "localhost",
            userName: "binding-test",
            userHandle: Data([1]),
            clientDataHash: clientDataHash,
            verification: NativeUserVerification(binding: wrongBinding)
        ))

        let correctBinding = NativeUserVerificationBinding.registration(
            relyingParty: "localhost",
            userHandle: Data([1]),
            clientDataHash: clientDataHash
        )
        XCTAssertThrowsError(try broker.register(
            relyingParty: "localhost",
            userName: "expired-test",
            userHandle: Data([1]),
            clientDataHash: clientDataHash,
            verification: NativeUserVerification(binding: correctBinding, lifetime: -1)
        ))

        XCTAssertThrowsError(try broker.register(
            relyingParty: "localhost",
            userName: "hash-mismatch-test",
            userHandle: Data([1]),
            clientDataHash: PasskeyCodec.sha256(Data("other-registration".utf8)),
            verification: NativeUserVerification(binding: correctBinding)
        ))
    }
}
