import nodemailer from 'nodemailer';
import type { EmailNotificationSettings, ToolExecutionResult } from '../../shared/types.js';

export class EmailNotifier {
  async send(settings: EmailNotificationSettings, subject: string, body: string): Promise<ToolExecutionResult> {
    if (!settings.enabled) return { ok: false, content: 'Email notifications are disabled.' };
    if (!settings.host || !settings.username || !settings.password || !settings.from || !settings.to) {
      return { ok: false, content: 'Email settings are incomplete.' };
    }
    try {
      const secure = settings.secure || Number(settings.port) === 465;
      const transporter = nodemailer.createTransport({
        host: settings.host,
        port: Number(settings.port) || (secure ? 465 : 587),
        secure,
        requireTLS: !secure,
        auth: {
          user: settings.username,
          pass: settings.password
        },
        tls: {
          servername: settings.host,
          minVersion: 'TLSv1.2'
        }
      });

      const info = await transporter.sendMail({
        from: settings.from,
        to: settings.to,
        subject,
        text: body
      });

      const accepted = info.accepted.length > 0 ? info.accepted.join(', ') : settings.to;
      return { ok: true, content: `Email sent to ${accepted}.` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, content: `SMTP send failed: ${message}` };
    }
  }
}
