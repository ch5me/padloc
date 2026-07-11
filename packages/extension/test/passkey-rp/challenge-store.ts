import { randomBytes, randomUUID } from "crypto";

export type CeremonyKind = "registration" | "assertion";

export interface CeremonyChallenge {
    id: string;
    challenge: Uint8Array;
    kind: CeremonyKind;
    expiresAt: number;
}

export class ChallengeStore {
    private readonly pending = new Map<string, CeremonyChallenge>();

    constructor(private readonly ttlMs = 60_000, private readonly now = () => Date.now()) {}

    issue(kind: CeremonyKind): CeremonyChallenge {
        const value = { id: randomUUID(), challenge: randomBytes(32), kind, expiresAt: this.now() + this.ttlMs };
        this.pending.set(value.id, value);
        return value;
    }

    consume(id: string, kind: CeremonyKind): CeremonyChallenge {
        const value = this.pending.get(id);
        this.pending.delete(id);
        if (!value) throw new Error("unknown or replayed ceremony");
        if (value.kind !== kind) throw new Error("ceremony type mismatch");
        if (value.expiresAt <= this.now()) throw new Error("ceremony expired");
        return value;
    }
}
