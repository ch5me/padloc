@preconcurrency import AuthenticationServices
import AppKit
import CH5AuthNativeCore
import CryptoKit
import Foundation
import OSLog

final class CredentialProviderViewController: ASCredentialProviderViewController {
    private let broker = NativePasskeyBroker()
    private let userVerifier: any NativeUserVerifying = DeviceOwnerUserVerifier()
    private let logger = Logger(subsystem: "me.ch5.auth.dev.passkeys.provider", category: "ceremony")

    override func loadView() {
        view = NSView(frame: NSRect(x: 0, y: 0, width: 420, height: 240))
    }

    private func mark(_ stage: String) {
        UserDefaults.standard.set(stage, forKey: "RedactedCeremonyStage")
    }

    private func credentialFingerprint(_ credentialID: Data) -> String {
        SHA256.hash(data: credentialID).prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    override func provideCredentialWithoutUserInteraction(for credentialRequest: any ASCredentialRequest) {
        guard let request = credentialRequest as? ASPasskeyCredentialRequest else {
            cancel(.credentialIdentityNotFound)
            return
        }
        provideAssertion(request)
    }

    override func prepareInterfaceToProvideCredential(for credentialRequest: any ASCredentialRequest) {
        provideCredentialWithoutUserInteraction(for: credentialRequest)
    }

    override func prepareInterface(forPasskeyRegistration registrationRequest: any ASCredentialRequest) {
        guard let request = registrationRequest as? ASPasskeyCredentialRequest else {
            cancel(.failed)
            return
        }
        provideRegistration(request)
    }

    private func provideRegistration(_ request: ASPasskeyCredentialRequest) {
        mark("registration-entered")
        logger.notice("registration entered")
        guard let identity = request.credentialIdentity as? ASPasskeyCredentialIdentity else {
            logger.error("registration rejected category=identity")
            cancel(.failed)
            return
        }
        guard request.supportedAlgorithms.contains(ASCOSEAlgorithmIdentifier.ES256) else {
            logger.error("registration rejected category=algorithm")
            cancel(.failed)
            return
        }
        cleanupPendingRegistrations { [weak self] in
            guard let self else { return }
            Task { @MainActor in
            let binding = NativeUserVerificationBinding.registration(
                relyingParty: identity.relyingPartyIdentifier,
                userHandle: identity.userHandle,
                clientDataHash: request.clientDataHash
            )
            guard let verification = await userVerifier.verify(
                reason: "Verify to save this passkey in CH5 Auth",
                binding: binding
            ) else {
                mark("verification-cancelled")
                logger.notice("registration verification result=cancelled")
                cancel(.userCanceled)
                return
            }
            logger.notice("registration verification result=verified")
            completeRegistration(request, identity: identity, verification: verification)
            }
        }
    }

    private func cleanupPendingRegistrations(completion: @escaping @MainActor () -> Void) {
        let pending: [NativePasskeyRecord]
        do {
            pending = try broker.pendingRegistrations()
        } catch {
            logger.error("registration pending cleanup category=store")
            cancel(.failed)
            return
        }
        guard !pending.isEmpty else {
            completion()
            return
        }
        let identities = pending.map { record in
            ASPasskeyCredentialIdentity(
                relyingPartyIdentifier: record.relyingParty,
                userName: record.userName,
                credentialID: record.credentialID,
                userHandle: record.userHandle,
                recordIdentifier: record.credentialID.base64EncodedString()
            )
        }
        ASCredentialIdentityStore.shared.removeCredentialIdentities(identities) { success, _ in
            Task { @MainActor in
                guard success else {
                    self.logger.error("registration pending cleanup category=identity")
                    self.cancel(.failed)
                    return
                }
                pending.forEach(self.broker.discardPendingRegistration)
                completion()
            }
        }
    }

    private func completeRegistration(
        _ request: ASPasskeyCredentialRequest,
        identity: ASPasskeyCredentialIdentity,
        verification: NativeUserVerification
    ) {
        do {
            mark("key-create")
            logger.notice("registration stage=key-create")
            let registration = try broker.register(
                relyingParty: identity.relyingPartyIdentifier,
                userName: identity.userName,
                userHandle: identity.userHandle,
                clientDataHash: request.clientDataHash,
                verification: verification
            )
            let record = registration.record
            logger.notice("registration credential fingerprint=\(self.credentialFingerprint(record.credentialID), privacy: .public)")
            logger.notice("registration stage=response-build")
            let credential = ASPasskeyRegistrationCredential(
                relyingParty: record.relyingParty,
                clientDataHash: request.clientDataHash,
                credentialID: record.credentialID,
                attestationObject: registration.attestationObject
            )
            let published = ASPasskeyCredentialIdentity(
                relyingPartyIdentifier: record.relyingParty,
                userName: record.userName,
                credentialID: record.credentialID,
                userHandle: record.userHandle,
                recordIdentifier: record.credentialID.base64EncodedString()
            )
            logger.notice("registration stage=identity-publish")
            ASCredentialIdentityStore.shared.saveCredentialIdentities([published]) { success, _ in
                Task { @MainActor in
                    guard success else {
                        self.broker.discard(registration)
                        self.mark("identity-publish-failed")
                        self.logger.notice("registration identity result=rejected")
                        self.cancel(.failed)
                        return
                    }
                    self.mark("identity-published")
                    self.logger.notice("registration identity result=published")
                    self.logger.notice("registration stage=complete")
                    self.mark("completion-called")
                    self.extensionContext.completeRegistrationRequest(using: credential) { expired in
                        Task { @MainActor in
                            self.mark(expired ? "completion-expired" : "completion-accepted")
                            self.logger.notice("registration completion result=\(expired ? "expired" : "accepted", privacy: .public)")
                            if expired {
                                ASCredentialIdentityStore.shared.removeCredentialIdentities([published]) { success, _ in
                                    guard success else {
                                        self.logger.error("registration compensation category=identity")
                                        return
                                    }
                                    self.broker.discard(registration)
                                }
                            } else {
                                self.broker.commit(registration)
                            }
                        }
                    }
                }
            }
        } catch let error as NativePasskeyStoreError {
            mark("internal-failure")
            switch error {
            case .keychain, .randomGenerationFailed:
                logger.error("registration failed category=keychain")
            default:
                logger.error("registration failed category=store")
            }
            cancel(.failed)
        } catch {
            mark("internal-failure")
            logger.error("registration failed category=internal")
            cancel(.failed)
        }
    }

    private func provideAssertion(_ request: ASPasskeyCredentialRequest) {
        logger.notice("assertion entered")
        guard let identity = request.credentialIdentity as? ASPasskeyCredentialIdentity else {
            cancel(.credentialIdentityNotFound)
            return
        }
        cleanupPendingRegistrations { [weak self] in
            guard let self else { return }
            Task { @MainActor in
            let binding = NativeUserVerificationBinding.assertion(
                relyingParty: identity.relyingPartyIdentifier,
                credentialID: identity.credentialID,
                clientDataHash: request.clientDataHash
            )
            guard let verification = await userVerifier.verify(
                reason: "Verify to use this CH5 Auth passkey",
                binding: binding
            ) else {
                    logger.notice("assertion verification result=cancelled")
                    cancel(.userCanceled)
                    return
                }
                logger.notice("assertion verification result=verified")
                completeAssertion(request, identity: identity, verification: verification)
            }
        }
    }

    private func completeAssertion(
        _ request: ASPasskeyCredentialRequest,
        identity: ASPasskeyCredentialIdentity,
        verification: NativeUserVerification
    ) {
        do {
            let assertion = try broker.assert(
                credentialID: identity.credentialID,
                relyingParty: identity.relyingPartyIdentifier,
                clientDataHash: request.clientDataHash,
                verification: verification
            )
            let record = assertion.record
            logger.notice("assertion credential fingerprint=\(self.credentialFingerprint(record.credentialID), privacy: .public)")
            let credential = ASPasskeyAssertionCredential(
                userHandle: record.userHandle,
                relyingParty: record.relyingParty,
                signature: assertion.signature,
                clientDataHash: request.clientDataHash,
                authenticatorData: assertion.authenticatorData,
                credentialID: record.credentialID
            )
            extensionContext.completeAssertionRequest(using: credential, completionHandler: nil)
        } catch {
            logger.error("assertion failed category=not-found")
            cancel(.credentialIdentityNotFound)
        }
    }

    private func cancel(_ code: ASExtensionError.Code) {
        extensionContext.cancelRequest(withError: NSError(domain: ASExtensionErrorDomain, code: code.rawValue))
    }
}
