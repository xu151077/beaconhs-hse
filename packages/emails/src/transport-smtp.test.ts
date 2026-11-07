import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server, type Socket } from 'node:net'
import { sendVia, type EmailTransport } from './transport'

/**
 * Behavioral SMTP tests against a real stub server on loopback.
 *
 * The mocked `createTransport` tests in `transport.test.ts` prove which
 * options BeaconHS *requests*; these prove what Nodemailer 9 *does* with
 * them: a credentialed STARTTLS connection must fail closed when the server
 * offers no STARTTLS (no AUTH line, no password bytes on the wire), while an
 * unauthenticated internal relay still delivers.
 *
 * The stub never sees the public internet: it binds `::` with an ephemeral
 * port, and `localhost` resolves locally. `allowNonPublic` is what lets the
 * `database` transport reach loopback at all (production keeps it off).
 */

type Transcript = { lines: string[]; bytes: Buffer[] }

function startStub(): Promise<{ server: Server; port: number; transcripts: Transcript[] }> {
  const transcripts: Transcript[] = []
  const server = createServer((socket: Socket) => {
    const transcript: Transcript = { lines: [], bytes: [] }
    transcripts.push(transcript)
    let dataMode = false
    let dataChunks: Buffer[] = []
    socket.setEncoding('utf8')
    socket.write('220 localhost stub-smtp\r\n')
    socket.on('data', (chunk: string) => {
      transcript.bytes.push(Buffer.from(chunk, 'utf8'))
      if (dataMode) {
        dataChunks.push(Buffer.from(chunk, 'utf8'))
        const all = Buffer.concat(dataChunks).toString('utf8')
        if (all.includes('\r\n.\r\n')) {
          dataMode = false
          dataChunks = []
          socket.write('250 ok: queued\r\n')
        }
        return
      }
      for (const rawLine of chunk.split('\r\n')) {
        if (!rawLine) continue
        transcript.lines.push(rawLine)
        const verb = rawLine.split(' ')[0]?.toUpperCase() ?? ''
        switch (verb) {
          case 'EHLO':
          case 'HELO':
            // Deliberately no STARTTLS advertisement: this stub models a
            // legacy relay that cannot upgrade.
            socket.write('250-localhost\r\n250 HELP\r\n')
            break
          case 'STARTTLS':
            socket.write('502 Command not implemented\r\n')
            break
          case 'AUTH':
            transcript.lines.push(`(auth-attempted) ${rawLine.slice(0, 12)}`)
            socket.write('535 Authentication failed\r\n')
            break
          case 'MAIL':
            socket.write('250 ok\r\n')
            break
          case 'RCPT':
            socket.write('250 ok\r\n')
            break
          case 'DATA':
            dataMode = true
            dataChunks = []
            socket.write('354 end with .\r\n')
            break
          case 'QUIT':
            socket.write('221 bye\r\n')
            socket.end()
            break
          case 'RSET':
            socket.write('250 ok\r\n')
            break
          default:
            socket.write('502 unimplemented\r\n')
            break
        }
      }
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '::', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('stub SMTP server did not bind a port'))
        return
      }
      resolve({ server, port: address.port, transcripts })
    })
  })
}

let stub: { server: Server; port: number; transcripts: Transcript[] } | null = null

afterEach(async () => {
  if (stub) {
    await new Promise<void>((resolve) => stub!.server.close(() => resolve()))
    stub = null
  }
})

function relayTransport(port: number, withCreds: boolean): EmailTransport {
  return {
    provider: 'smtp',
    mode: 'database',
    host: 'localhost',
    port,
    secure: false,
    ...(withCreds ? { username: 'relay-user', password: 'relay-password-no-leak' } : {}),
    from: 'sender@example.com',
    allowNonPublic: true,
  }
}

const INPUT = {
  to: 'dest@example.com',
  subject: 'Behavioral probe',
  html: '<p>Behavioral probe</p>',
  text: 'Behavioral probe',
}

function wire(transcripts: Transcript[]): string {
  return transcripts
    .flatMap((t) => [...t.lines, ...t.bytes.map((b) => b.toString('utf8'))])
    .join('\n')
}

describe('sendVia against a stub SMTP relay (behavioral TLS)', () => {
  it('fails closed with credentials when the server offers no STARTTLS', async () => {
    stub = await startStub()
    const outcome = await sendVia(relayTransport(stub.port, true), INPUT).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    expect(outcome.ok).toBe(false)

    const transcript = wire(stub.transcripts)
    // The client asked to upgrade…
    expect(transcript).toMatch(/STARTTLS/)
    // …the server refused, and no credential ever crossed the wire.
    expect(transcript).not.toMatch(/AUTH/)
    expect(transcript).not.toContain('relay-password-no-leak')
    expect(transcript).not.toContain('relay-user')
  }, 30_000)

  it('delivers over an unauthenticated internal relay without STARTTLS', async () => {
    stub = await startStub()
    await expect(sendVia(relayTransport(stub.port, false), INPUT)).resolves.toEqual({
      id: expect.any(String),
    })

    const transcript = wire(stub.transcripts)
    expect(transcript).toMatch(/MAIL FROM/)
    expect(transcript).toMatch(/RCPT TO/)
    expect(transcript).not.toMatch(/AUTH/)
  }, 30_000)

  it('fails implicit TLS against a plaintext relay without sending credentials', async () => {
    stub = await startStub()
    const transport: EmailTransport = {
      provider: 'smtp',
      mode: 'database',
      host: 'localhost',
      port: stub.port,
      secure: true,
      username: 'relay-user',
      password: 'relay-password-no-leak',
      from: 'sender@example.com',
      allowNonPublic: true,
    }
    const outcome = await sendVia(transport, INPUT).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    expect(outcome.ok).toBe(false)

    const transcript = wire(stub.transcripts)
    expect(transcript).not.toMatch(/AUTH/)
    expect(transcript).not.toContain('relay-password-no-leak')
  }, 30_000)
})
