/**
 * Outbound mail for the self-hosted auth surface.
 *
 * Nothing in `@mastra/factory`, `@mastra/code-sdk` or `@mastra/auth-better-auth`
 * sends email — that is the self-hosting boundary, not a defect. On Mastra
 * Cloud the platform owns delivery; self-hosted, we own it. Resend is the
 * transport because the account and a verified sending domain already exist.
 *
 * `mailConfigured` is deliberately load-bearing. Better Auth decides whether to
 * MOUNT a flow from the presence of its sender callback: with no
 * `sendResetPassword`, `/request-password-reset` answers "Reset password isn't
 * enabled" (api/routes/password.mjs:51). Wiring a callback that silently drops
 * the message instead would make the endpoint answer "check your email" when
 * nothing was sent — the exact failure this module exists to remove. So the
 * callbacks are attached only when a transport is actually configured.
 */
import { Resend } from 'resend';

const apiKey = process.env.RESEND_API_KEY?.trim();
const from = process.env.MAIL_FROM?.trim();
const replyTo = process.env.MAIL_REPLY_TO?.trim() || undefined;

/**
 * Whether outbound mail can actually be delivered. Both halves are required:
 * a key with no verified `from` address fails at send time, which is worse
 * than declining to mount the flow.
 */
export const mailConfigured = Boolean(apiKey && from);

const client = apiKey ? new Resend(apiKey) : undefined;

export interface OutboundMail {
  to: string;
  subject: string;
  /** Plain-text body. Always sent — some clients never render the HTML part. */
  text: string;
  /** Optional HTML body. */
  html?: string;
}

/**
 * Send one message. Throws on failure so Better Auth surfaces the error rather
 * than reporting success for a message that never left.
 */
export async function sendMail(mail: OutboundMail): Promise<void> {
  if (!client || !from) {
    throw new Error(
      'sendMail called with no transport configured. Set RESEND_API_KEY and MAIL_FROM, or do not attach the sender callbacks.',
    );
  }

  const { data, error } = await client.emails.send({
    from,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    ...(mail.html ? { html: mail.html } : {}),
    ...(replyTo ? { replyTo } : {}),
  });

  if (error) {
    // Resend returns the failure in the body, not as a thrown error or a
    // non-2xx, so an unchecked call looks like a success.
    console.error(`[mail] send failed (${mail.subject} -> ${mail.to}): ${error.name}: ${error.message}`);
    throw new Error(`Resend rejected the message: ${error.name}: ${error.message}`);
  }

  console.log(`[mail] sent ${JSON.stringify(mail.subject)} to ${mail.to} (id ${data?.id ?? 'unknown'})`);
}

/** Escape text for HTML element content and double-quoted attributes. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A minimal HTML body. Kept here so every auth email looks the same. */
export function basicHtml(heading: string, body: string, actionUrl: string, actionLabel: string): string {
  return [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5;color:#1a1a1a">',
    `<h2 style="margin:0 0 16px;font-size:18px">${heading}</h2>`,
    `<p style="margin:0 0 20px">${body}</p>`,
    `<p style="margin:0 0 20px"><a href="${actionUrl}" style="display:inline-block;padding:10px 18px;background:#1a1a1a;color:#fff;text-decoration:none;border-radius:6px">${actionLabel}</a></p>`,
    `<p style="margin:0;font-size:13px;color:#666">Or paste this link into your browser:<br><span style="word-break:break-all">${actionUrl}</span></p>`,
    '</div>',
  ].join('');
}
