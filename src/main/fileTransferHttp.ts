import { request } from 'node:http'
import { z } from 'zod'
import { FILE_TRANSFER_LIMITS, FileTransferError, transferErrorCodeSchema } from '../shared/fileTransfer'

export type FileRoute = 'capabilities' | 'prepare' | 'chunk' | 'release'
const errorSchema = z.object({ error: z.object({ code: transferErrorCodeSchema, message: z.string().max(2000) }).strict() }).strict()

export async function fileDeviceRequest(port: number, remotePort: number, token: string, route: FileRoute, value: unknown, signal: AbortSignal): Promise<unknown | Buffer> {
  const body = JSON.stringify(value)
  if (Buffer.byteLength(body) > 64 * 1024) throw new FileTransferError('INVALID_REQUEST', 'The file request is too large.')
  const cancellation = AbortSignal.any([signal, AbortSignal.timeout(route === 'prepare' ? 60_000 : 15_000)])
  return new Promise((resolve, reject) => {
    const operation = request({
      hostname: '127.0.0.1', port, path: `/device/files/${route}`, method: 'POST', signal: cancellation,
      headers: { Host: `127.0.0.1:${remotePort}`, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (response) => {
      const status = response.statusCode ?? 500
      const binary = route === 'chunk' && status === 200
      const limit = binary ? FILE_TRANSFER_LIMITS.chunkBytes : 64 * 1024
      const chunks: Buffer[] = []
      let length = 0
      response.on('error', () => reject(new FileTransferError('UNAVAILABLE', 'The file transfer connection was interrupted.')))
      response.on('aborted', () => reject(new FileTransferError('UNAVAILABLE', 'The file transfer response was incomplete.')))
      response.on('data', (chunk: Buffer) => {
        length += chunk.length
        if (length > limit) response.destroy(new FileTransferError('INVALID_REQUEST', 'The file response exceeded its limit.'))
        else chunks.push(chunk)
      })
      response.on('end', () => {
        const bytes = Buffer.concat(chunks)
        if (status === 200 && binary) {
          if (response.headers['content-type'] !== 'application/octet-stream') { reject(new FileTransferError('INVALID_REQUEST', 'Invalid file chunk response.')); return }
          resolve(bytes)
          return
        }
        let result: unknown
        try { result = JSON.parse(bytes.toString('utf8')) }
        catch {
          reject(new FileTransferError(status === 404 ? 'UNSUPPORTED' : status === 403 ? 'ACCESS_DENIED' : 'UNAVAILABLE',
            status === 404 ? 'Update Task Continuum on the source device to enable file transfers.' : status === 403 ? 'Device access is unavailable, revoked or expired.' : 'The source device returned an invalid response.'))
          return
        }
        if (status !== 200) {
          const failure = errorSchema.safeParse(result)
          reject(failure.success ? new FileTransferError(failure.data.error.code, failure.data.error.message)
            : new FileTransferError('UNAVAILABLE', 'The source device could not complete the file request.'))
        } else resolve(result)
      })
    })
    operation.on('error', () => reject(new FileTransferError('UNAVAILABLE', cancellation.aborted
      ? 'The file request was cancelled or timed out. Resume the same transfer when the device is available.'
      : 'The source device could not be reached.')))
    operation.end(body)
  })
}
