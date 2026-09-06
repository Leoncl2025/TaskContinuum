import type { ChatAdapter, ChatEvent, ChatRequest } from '../../shared/chat'

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return }
    const abort = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}

export function demoResponse({ task, message }: Pick<ChatRequest, 'task' | 'message'>): string {
  const prompt = message.toLowerCase()
  if (/risk|review|block/.test(prompt)) {
    return `Review notes for ${task.id}\n\nKeep the scope focused on: ${task.goal}\n\nBefore moving on, verify the unfinished acceptance criteria:\n${task.checklist.filter((item) => !item.done).map((item) => `• ${item.title}`).join('\n') || '• All sample criteria are checked. Revalidate them against real evidence.'}\n\nThis is a local demo response. No model, files, or tools were accessed.`
  }
  if (/next|plan|step/.test(prompt)) {
    return `A next step for ${task.id}\n\n${task.nextAction}\n\nSuggested sequence from the sample plan:\n${task.plan.map((step, index) => `${index + 1}. ${step}`).join('\n')}\n\nLocal demo only — this response is assembled from the selected task.`
  }
  return `${task.id} · ${task.title}\n\n${task.goal}\n\nNext action\n${task.nextAction}\n\nI am the local demo adapter. Your message stays in this task's conversation; a real Agent Harness will connect through the same UI boundary later.`
}

export const demoChatAdapter: ChatAdapter = {
  label: 'Local demo',
  kind: 'demo',
  async *stream(request): AsyncIterable<ChatEvent> {
    request.signal.throwIfAborted()
    const chunks = demoResponse(request).match(/\S+\s*/g) ?? []
    for (let index = 0; index < chunks.length; index += 3) {
      await wait(18, request.signal)
      yield { type: 'delta', text: chunks.slice(index, index + 3).join('') }
    }
    yield { type: 'complete' }
  },
}