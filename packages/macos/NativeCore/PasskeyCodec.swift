import CryptoKit
import Foundation

public enum PasskeyCodecError: Error {
    case invalidCoordinate
    case unsupportedKey
}

public enum PasskeyCodec {
    // AuthenticationServices credential-provider passkeys are synchronized
    // credentials, so both backup eligibility and backup state are asserted.
    private static let userPresentAndSynchronized: UInt8 = 0x19

    public static func sha256(_ data: Data) -> Data {
        Data(SHA256.hash(data: data))
    }

    public static func registrationAuthenticatorData(
        relyingParty: String,
        credentialID: Data,
        publicKey: P256.Signing.PublicKey,
        userVerified: Bool
    ) throws -> Data {
        let x963 = publicKey.x963Representation
        guard x963.count == 65, x963.first == 4 else { throw PasskeyCodecError.invalidCoordinate }
        let x = x963.subdata(in: 1..<33)
        let y = x963.subdata(in: 33..<65)
        var result = sha256(Data(relyingParty.utf8))
        result.append(userPresentAndSynchronized | (userVerified ? 0x44 : 0x40))
        result.append(contentsOf: [0, 0, 0, 0])
        result.append(Data(repeating: 0, count: 16))
        result.append(UInt8((credentialID.count >> 8) & 0xff))
        result.append(UInt8(credentialID.count & 0xff))
        result.append(credentialID)
        result.append(coseES256(x: x, y: y))
        return result
    }

    public static func assertionAuthenticatorData(relyingParty: String, userVerified: Bool) -> Data {
        var result = sha256(Data(relyingParty.utf8))
        result.append(userPresentAndSynchronized | (userVerified ? 0x04 : 0x00))
        result.append(contentsOf: [0, 0, 0, 0])
        return result
    }

    public static func noneAttestationObject(authenticatorData: Data) -> Data {
        cborMap([
            (.text("fmt"), .text("none")),
            (.text("authData"), .bytes(authenticatorData)),
            (.text("attStmt"), .map([])),
        ])
    }

    private static func coseES256(x: Data, y: Data) -> Data {
        cborMap([
            (.negativeOrPositive(1), .negativeOrPositive(2)),
            (.negativeOrPositive(3), .negativeOrPositive(-7)),
            (.negativeOrPositive(-1), .negativeOrPositive(1)),
            (.negativeOrPositive(-2), .bytes(x)),
            (.negativeOrPositive(-3), .bytes(y)),
        ])
    }

    private enum CBORValue {
        case text(String)
        case bytes(Data)
        case negativeOrPositive(Int)
        case map([(CBORValue, CBORValue)])
    }

    private static func cborMap(_ entries: [(CBORValue, CBORValue)]) -> Data {
        encode(.map(entries))
    }

    private static func encode(_ value: CBORValue) -> Data {
        switch value {
        case let .text(text):
            let bytes = Data(text.utf8)
            return encodeLength(major: 3, count: bytes.count) + bytes
        case let .bytes(bytes):
            return encodeLength(major: 2, count: bytes.count) + bytes
        case let .negativeOrPositive(integer):
            if integer >= 0 { return encodeLength(major: 0, count: integer) }
            return encodeLength(major: 1, count: -1 - integer)
        case let .map(entries):
            var data = encodeLength(major: 5, count: entries.count)
            for (key, item) in entries {
                data.append(encode(key))
                data.append(encode(item))
            }
            return data
        }
    }

    private static func encodeLength(major: UInt8, count: Int) -> Data {
        precondition(count >= 0)
        if count < 24 { return Data([(major << 5) | UInt8(count)]) }
        if count <= 0xff { return Data([(major << 5) | 24, UInt8(count)]) }
        if count <= 0xffff {
            return Data([(major << 5) | 25, UInt8((count >> 8) & 0xff), UInt8(count & 0xff)])
        }
        var value = UInt32(count).bigEndian
        return Data([(major << 5) | 26]) + Data(bytes: &value, count: 4)
    }
}
