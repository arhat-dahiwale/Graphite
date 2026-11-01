import { childLogger } from "@graphite/core";

const log = childLogger({ component: "mailer" });

export interface InviteEmail {
  to: string;
  organizationName: string;
  inviteUrl: string;
  roleName: string;
}

/**
 * Outbound email. SMTP is not configured in this environment; the console
 * transport logs the invitation URL so the flow stays testable end to end.
 * In dev the raw token is also returned by member.invite (documented in API.md).
 */
export async function sendInviteEmail(email: InviteEmail): Promise<void> {
  log.info(
    { to: email.to, organization: email.organizationName, role: email.roleName },
    `invite link (console transport): ${email.inviteUrl}`,
  );
}
