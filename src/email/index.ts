// Email provider adapter — same pattern as storage/transcription/extraction:
// config-driven factory, deterministic dev/test implementation, real provider
// (Resend) behind env config. Only used for password-reset email in this slice.

export interface PasswordResetEmail {
  to: string
  resetUrl: string
}

export interface EmailProvider {
  readonly name: string
  sendPasswordReset(email: PasswordResetEmail): Promise<void>
}

// Dev/test provider: never sends real email. Logs the reset URL and keeps the
// last sent message inspectable so dev flows and tests are deterministic.
export class DevEmailProvider implements EmailProvider {
  readonly name = 'dev'
  public sent: PasswordResetEmail[] = []

  async sendPasswordReset(email: PasswordResetEmail): Promise<void> {
    this.sent.push(email)
    // Deliberate: dev-only visibility of the reset link (never runs in production).
    console.log(`[dev-email] Password reset for ${email.to}: ${email.resetUrl}`)
  }
}

export class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend'

  constructor(
    private readonly apiKey: string,
    private readonly fromAddress: string,
  ) {}

  async sendPasswordReset(email: PasswordResetEmail): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.fromAddress,
        to: [email.to],
        subject: 'Reset your Job Book password',
        text:
          `Someone asked to reset the password for your Job Book account.\n\n` +
          `Reset your password: ${email.resetUrl}\n\n` +
          `This link expires soon and can only be used once. ` +
          `If you did not ask for this, you can ignore this email.`,
      }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Resend API error ${res.status}: ${body.slice(0, 200)}`)
    }
  }
}

export function createEmailProvider(env: NodeJS.ProcessEnv = process.env): EmailProvider {
  if (env.EMAIL_PROVIDER === 'resend') {
    const apiKey = env.RESEND_API_KEY
    const from = env.EMAIL_FROM
    if (!apiKey || !from) {
      throw new Error('EMAIL_PROVIDER=resend requires RESEND_API_KEY and EMAIL_FROM')
    }
    return new ResendEmailProvider(apiKey, from)
  }
  return new DevEmailProvider()
}
