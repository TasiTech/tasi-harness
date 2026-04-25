import { Buffer } from 'node:buffer';
import net from 'node:net';
import tls from 'node:tls';
import type { EmailNotificationSettings, ToolExecutionResult } from '../../shared/types.js';

function waitForLine(socket: net.Socket | tls.TLSSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (/\r?\n$/.test(text)) {
        cleanup();
        resolve(text);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
    };
    socket.on('data', onData);
    socket.on('error', onError);
  });
}

async function sendLine(socket: net.Socket | tls.TLSSocket, line: string): Promise<string> {
  socket.write(`${line}\r\n`);
  return waitForLine(socket);
}

export class EmailNotifier {
  async send(settings: EmailNotificationSettings, subject: string, body: string): Promise<ToolExecutionResult> {
    if (!settings.enabled) return { ok: false, content: 'Email notifications are disabled.' };
    if (!settings.host || !settings.username || !settings.password || !settings.from || !settings.to) {
      return { ok: false, content: 'Email settings are incomplete.' };
    }

    const socket = settings.secure
      ? tls.connect(settings.port, settings.host, { servername: settings.host })
      : net.connect(settings.port, settings.host);

    try {
      await waitForLine(socket);
      await sendLine(socket, `EHLO ${settings.host}`);
      await sendLine(socket, 'AUTH LOGIN');
      await sendLine(socket, Buffer.from(settings.username).toString('base64'));
      await sendLine(socket, Buffer.from(settings.password).toString('base64'));
      await sendLine(socket, `MAIL FROM:<${settings.from}>`);
      await sendLine(socket, `RCPT TO:<${settings.to}>`);
      await sendLine(socket, 'DATA');
      await sendLine(
        socket,
        [
          `From: ${settings.from}`,
          `To: ${settings.to}`,
          `Subject: ${subject}`,
          'Content-Type: text/plain; charset=utf-8',
          '',
          body,
          '.'
        ].join('\r\n')
      );
      await sendLine(socket, 'QUIT');
      socket.end();
      return { ok: true, content: `Email sent to ${settings.to}.` };
    } catch (error) {
      socket.destroy();
      return { ok: false, content: error instanceof Error ? error.message : String(error) };
    }
  }
}
