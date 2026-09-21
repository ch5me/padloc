import {
    Message,
    MessageData,
    EmailAuthMessage,
    JoinOrgInviteMessage,
    ConfirmMembershipInviteMessage,
} from "@elf-vault/core/src/messenger";
import { Err, ErrorCode } from "@elf-vault/core/src/error";
import { getTemplate, interpolate } from "./templates";

export class ResendMessenger {
    constructor(private apiKey: string, private fromAddress: string) {}

    async send<T extends MessageData>(addr: string, msg: Message<T>): Promise<void> {
        const { html, txt } = this._render(msg);
        const idempotencyKey = this._idempotencyKey(msg);

        const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                "Content-Type": "application/json",
                "Idempotency-Key": idempotencyKey,
            },
            body: JSON.stringify({
                from: this.fromAddress,
                to: addr,
                subject: msg.title,
                html,
                text: txt,
            }),
        });

        if (!res.ok) {
            console.error("Resend send failed", {
                status: res.status,
                template: msg.template,
            });
            throw new Err(ErrorCode.SERVER_ERROR, `Resend request failed [${res.status}]`, {
                report: true,
            });
        }

        let messageId: string | null = null;
        try {
            const body = (await res.json()) as { id?: unknown };
            if (typeof body.id === "string") {
                messageId = body.id;
            }
        } catch {
            messageId = null;
        }
        console.log("[ResendMessenger] sent", { template: msg.template, messageId });
    }

    private _render<T extends MessageData>(msg: Message<T>): { html: string; txt: string } {
        const { html, txt } = getTemplate(msg.template);
        const vars = { ...msg.data };
        return {
            html: interpolate(html, vars),
            txt: interpolate(txt, vars),
        };
    }

    private _idempotencyKey<T extends MessageData>(msg: Message<T>): string {
        if (msg instanceof EmailAuthMessage) {
            return `email-auth:${msg.data.requestId}`;
        }
        if (msg instanceof JoinOrgInviteMessage || msg instanceof ConfirmMembershipInviteMessage) {
            const data = msg.data as { acceptInviteUrl?: string };
            return `org-invite:${data.acceptInviteUrl ?? "unknown"}`;
        }
        return `email:${msg.template}:${Date.now()}`;
    }
}

export class MockMessenger {
    sent: {
        recipient: string;
        subject: string;
        html: string;
        text: string;
        idempotencyKey: string;
        template: string;
    }[] = [];

    async send<T extends MessageData>(addr: string, msg: Message<T>): Promise<void> {
        const { html, txt } = this._render(msg);
        const key = `mock:${msg.template}:${Date.now()}`;
        this.sent.push({
            recipient: addr,
            subject: msg.title,
            html,
            text: txt,
            idempotencyKey: key,
            template: msg.template,
        });
        console.log("[MockMessenger] sent", { template: msg.template, messageId: key });
    }

    private _render<T extends MessageData>(msg: Message<T>): { html: string; txt: string } {
        const { html, txt } = getTemplate(msg.template);
        const vars = { ...msg.data };
        return {
            html: interpolate(html, vars),
            txt: interpolate(txt, vars),
        };
    }

    lastMessage(addr: string) {
        const entry = this.sent.find((m) => m.recipient === addr);
        return entry ? { subject: entry.subject, html: entry.html, text: entry.text, template: entry.template } : null;
    }

    messagesFor(addr: string) {
        return this.sent.filter((m) => m.recipient === addr);
    }
}
