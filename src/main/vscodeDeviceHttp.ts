import { request } from 'node:http'

export class DeviceRequestError extends Error {
  constructor(readonly status: number) {
    super(status === 401 || status === 403 ? 'Device or session access was revoked or expired.' : 'The original session is unavailable. Reconnect its VS Code bridge on the owner.')
  }
}

export async function deviceRequest(port: number, remotePort: number, token: string, path: string, value: unknown, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const operation = request({ hostname: '127.0.0.1', port, path, method: 'POST',
      headers: { Host: `127.0.0.1:${remotePort}`, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    }, (response) => {
      response.on('error', reject)
      if (response.statusCode !== 200) {
        response.destroy()
        reject(new DeviceRequestError(response.statusCode ?? 500))
        return
      }
      const chunks: Buffer[] = []
      let length = 0
      response.on('data', (chunk: Buffer) => {
        length += chunk.length
        if (length > 4 * 1024 * 1024) response.destroy(new Error('Device response exceeds its limit.'))
        else chunks.push(chunk)
      })
      response.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new Error('Invalid device response.')) } })
    })
    operation.on('error', reject)
    operation.end(JSON.stringify(value))
  })
}