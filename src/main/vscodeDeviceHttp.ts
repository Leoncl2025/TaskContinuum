import { request } from 'node:http'

export class DeviceRequestError extends Error {
  constructor(readonly status: number, agentHostCreation = false) {
    super(agentHostCreation
      ? status === 401 || status === 403 ? 'The worker send permission or device pairing is unavailable, revoked, or expired.'
        : status === 404 ? 'This worker does not support the requested Agent Host creation operation. Update Task Continuum on the worker.'
          : status === 400 || status === 409 ? 'The creation request or task binding conflicts with the worker state. Refresh the same operation; do not create a replacement.'
            : 'The Agent Host worker could not confirm this operation. Check its status using the same operation ID.'
      : status === 401 || status === 403 ? 'Device or session access was revoked or expired.' : status === 404 ? 'This operation is unsupported. Update Task Continuum and its VS Code Bridge on the execution machine.' : status === 400 || status === 409 ? 'The original bridge could not complete this operation. Resolve pending delivery or inspect the original VS Code window before retrying.' : 'The original session is unavailable. Reconnect its VS Code bridge on the owner.')
  }
}

export async function deviceRequest(port: number, remotePort: number, token: string, path: string, value: unknown, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const deadline = AbortSignal.timeout(15000)
    const cancellation = AbortSignal.any([signal, deadline])
    const creation = path.startsWith('/device/agent-host/')
    const stage = creation ? 'Agent Host creation operation' : path === '/device/sessions' ? 'Owner session discovery' : path.endsWith('/read') ? 'Original-session history read' : path.endsWith('/send') ? 'Original-session submission' : 'Original-session opening'
    const failed = (error: Error) => {
      if (!cancellation.aborted) { reject(error); return }
      const timedOut = cancellation.reason?.name === 'TimeoutError'
      const outcome = path.endsWith('/create') || path.endsWith('/creation-bind') ? 'The outcome is not confirmed; query the same operation ID. No automatic creation retry.'
        : path.endsWith('/send') ? 'The message outcome is not confirmed; it will not be resent automatically.' : 'No message was sent by this operation.'
      reject(new Error(`${stage} ${timedOut ? 'timed out waiting for the owner' : 'was cancelled'}. ${outcome}`, { cause: error }))
    }
    const operation = request({ hostname: '127.0.0.1', port, path, method: 'POST',
      headers: { Host: `127.0.0.1:${remotePort}`, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: cancellation,
    }, (response) => {
      response.on('error', failed)
      if (response.statusCode !== 200) {
        response.destroy()
        reject(new DeviceRequestError(response.statusCode ?? 500, creation))
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
    operation.on('error', failed)
    operation.end(JSON.stringify(value))
  })
}