// Local type shim for @ch5me/elf-auth-client, redirected via tsconfig `paths`.
//
// padloc's Worker package pins TypeScript 4.4.3 (repo-wide, out of scope to change here).
// @ch5me/elf-auth-client's real .d.ts (and its transitive zod v4 / drizzle-orm dependency
// declarations) use syntax TS 4.4 cannot parse (e.g. `const` type parameters), which fails
// even with skipLibCheck (skipLibCheck skips type-*checking* of .d.ts files, not parsing them).
// This shim covers only the surface this package actually uses. It does not affect runtime
// module resolution -- wrangler/esbuild still bundles the real package.
declare module "@ch5me/elf-auth-client" {
    export interface ElfTokenPayload {
        elfUserId: string;
        organizationId?: string | null;
        organizationRole?: string | null;
        botId?: string | null;
        apiTokenPepper?: string | null;
    }

    export type ElfVerifyResult =
        | { valid: true; payload: ElfTokenPayload }
        | { valid: false; error: string };

    export interface ElfVerifier {
        verify(token: string): Promise<ElfVerifyResult>;
    }

    export interface CreateElfVerifierOptions {
        jwksUrl: string;
        issuer: string;
        audience: string;
    }

    export function createElfVerifier(options: CreateElfVerifierOptions): ElfVerifier;
}
