import CryptoKit
import Foundation
import LocalAuthentication

public final class NativeUserVerification: @unchecked Sendable {
    private let lock = NSLock()
    private let binding: Data
    private let expiresAt: Date
    private var consumed = false

    init(binding: Data, lifetime: TimeInterval = 120) {
        self.binding = binding
        expiresAt = Date().addingTimeInterval(lifetime)
    }

    func consume(binding expectedBinding: Data) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !consumed, Date() <= expiresAt, binding == expectedBinding else { return false }
        consumed = true
        return true
    }
}

public enum NativeUserVerificationBinding {
    public static func registration(relyingParty: String, userHandle: Data, clientDataHash: Data) -> Data {
        digest(parts: [Data("registration".utf8), Data(relyingParty.utf8), userHandle, clientDataHash])
    }

    public static func assertion(relyingParty: String, credentialID: Data, clientDataHash: Data) -> Data {
        digest(parts: [Data("assertion".utf8), Data(relyingParty.utf8), credentialID, clientDataHash])
    }

    private static func digest(parts: [Data]) -> Data {
        var encoded = Data()
        for part in parts {
            var length = UInt64(part.count).bigEndian
            withUnsafeBytes(of: &length) { encoded.append(contentsOf: $0) }
            encoded.append(part)
        }
        return Data(SHA256.hash(data: encoded))
    }
}

public protocol NativeUserVerifying: Sendable {
    func verify(reason: String, binding: Data) async -> NativeUserVerification?
}

public struct DeviceOwnerUserVerifier: NativeUserVerifying {
    public init() {}

    public func verify(reason: String, binding: Data) async -> NativeUserVerification? {
        let context = LAContext()
        context.localizedCancelTitle = "Cancel"
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else { return nil }
        do {
            return try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
                ? NativeUserVerification(binding: binding)
                : nil
        } catch {
            return nil
        }
    }
}

#if DEBUG && CH5_PASSKEY_TEST_VERIFICATION_INJECTION
/// Test-only synthetic grant factory. It never invokes LocalAuthentication and
/// must not be treated as biometric or system-sheet evidence.
public enum NativeTestVerificationInjection {
    public static func grant(binding: Data) -> NativeUserVerification {
        NativeUserVerification(binding: binding)
    }
}
#endif
