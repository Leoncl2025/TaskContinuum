import type { ChatAdapter, ChatEvent } from '../../shared/chat'
import type { CopilotBridge } from '../../shared/sessions'

export function createCopilotAdapter(bridge: CopilotBridge): ChatAdapter {
  return {
    label: 'GitHub Copilot',
    kind: 'live',
    async *stream(request) {
      request.signal.throwIfAborted()
      if (request.sessionId.startsWith('local:')) throw new Error('Open or create a Copilot session first.')
      const requestId = crypto.randomUUID()
      const queue: ChatEvent[] = []
      let finished = false
      let failure: Error | undefined
      let wake = () => {}
      const fail = (error: unknown) => {
        if (finished) return
        failure = error instanceof Error || error instanceof DOMException ? error : new Error('The local Copilot connection failed.')
        finished = true
        wake()
      }
      const unsubscribe = bridge.onEvent((event) => {
        if (finished || !('requestId' in event) || event.requestId !== requestId || event.sessionId !== request.sessionId) return
        if (event.type === 'delta' || event.type === 'activity') queue.push({ type: event.type, text: event.text })
        else if (event.type === 'complete') { queue.push({ type: 'complete' }); finished = true }
        else if (event.type === 'error') fail(new Error(event.error))
        wake()
      })
      const abort = () => {
        if (finished) return
        fail(new DOMException('The response was stopped.', 'AbortError'))
        void bridge.abort(requestId).catch(() => undefined)
      }
      request.signal.addEventListener('abort', abort, { once: true })
      try {
        request.signal.throwIfAborted()
        void bridge.send({ requestId, sessionId: request.sessionId, message: request.message, ...(request.images?.length ? { images: request.images } : {}) }).then(() => {
          if (!finished) fail(new Error('The local response ended without a completion event.'))
        }, fail)
        while (!finished || queue.length) {
          const event = queue.shift()
          if (event) yield event
          else await new Promise<void>((resolve) => { wake = resolve })
        }
        if (failure) throw failure
      } finally {
        request.signal.removeEventListener('abort', abort)
        unsubscribe()
        if (!finished) void bridge.abort(requestId).catch(() => undefined)
      }
    },
  }
}