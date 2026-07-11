import AuthenticationServices
import SwiftUI

@main
struct CH5AuthPasskeyProviderApp: App {
    @State private var providerState = "Checking provider registration…"

    var body: some Scene {
        WindowGroup {
            VStack(spacing: 16) {
                Image(systemName: "key.fill").font(.system(size: 44))
                Text("CH5 Auth Passkeys").font(.title2)
                Text("The native credential provider is installed. Enable CH5 Auth in Passwords & AutoFill to make it available to browsers.")
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 420)
                Text(providerState).font(.caption).foregroundStyle(.secondary)
                Button("Open Provider Settings") {
                    ASSettingsHelper.openCredentialProviderAppSettings(completionHandler: nil)
                }
            }
            .padding(36)
            .task {
                let state = await ASCredentialIdentityStore.shared.state()
                providerState = state.isEnabled ? "Provider enabled" : "Provider installed; enablement required"
            }
        }
    }
}
