import { useEffect, useReducer, useRef } from 'react'
import type { ChatAdapter, ChatMessage } from '../../shared/chat'
import type { TaskRecord } from '../../shared/tasks'
import type { ChatImageAttachment } from '../../shared/chatAttachments'

export interface TaskChat {
  sessionId?: string
  activity?: string
  draft: string
  images?: ChatImageAttachment[]
  messages: ChatMessage[]
}

type Action =
  | { type: 'draft'; taskId: string; value: string }
  | { type: 'images'; taskId: string; value: ChatImageAttachment[] }
  | { type: 'submit'; taskId: string; user: ChatMessage; assistant: ChatMessage }
  | { type: 'delta'; taskId: string; id: string; text: string }
  | { type: 'activity'; taskId: string; text: string }
  | { type: 'finish'; taskId: string; id: string; status: ChatMessage['status']; error?: string; retryDraft?: { text: string; images: ChatImageAttachment[] } }
  | { type: 'clear'; taskId: string }
  | { type: 'restore'; taskId: string; sessionId: string; messages: ChatMessage[] }

const emptyChat: TaskChat = { draft: '', messages: [] }

function reducer(state: Record<string, TaskChat>, action: Action): Record<string, TaskChat> {
  const thread = state[action.taskId] ?? emptyChat
  let next: TaskChat
  switch (action.type) {
    case 'draft': next = { ...thread, draft: action.value }; break
    case 'images': next = { ...thread, images: action.value }; break
    case 'submit': next = { ...thread, activity: undefined, draft: '', ...(thread.images ? { images: [] } : {}), messages: [...thread.messages, action.user, action.assistant] }; break
    case 'clear': next = { draft: '', messages: [] }; break
    case 'restore': next = { sessionId: action.sessionId, draft: '', messages: action.messages }; break
    case 'activity': next = { ...thread, activity: action.text }; break
    case 'delta': next = { ...thread, messages: thread.messages.map((message) => message.id === action.id ? { ...message, text: message.text + action.text } : message) }; break
    case 'finish': next = {
      ...thread, activity: undefined,
      ...(action.retryDraft && !thread.draft && !thread.images?.length && !thread.messages.find((message) => message.id === action.id)?.text ? { draft: action.retryDraft.text, images: action.retryDraft.images } : {}),
      messages: thread.messages.map((message) => message.id === action.id ? {
        ...message, status: action.status,
        text: action.error ? `${message.text}${message.text ? '\n\n' : ''}${action.error}` : message.text,
      } : message),
    }; break
  }
  return { ...state, [action.taskId]: next }
}

export function useTaskChats(adapter: ChatAdapter) {
  const [threads, dispatch] = useReducer(reducer, {})
  const controllers = useRef(new Map<string, AbortController>())

  useEffect(() => {
    const active = controllers.current
    return () => { for (const controller of active.values()) controller.abort(); active.clear() }
  }, [])

  async function send(task: TaskRecord, value: string): Promise<void> {
    const text = value.trim()
    const images = threads[task.id]?.images ?? []
    if (!text && !images.length || text.length > 4000 || controllers.current.has(task.id)) return
    const controller = new AbortController()
    controllers.current.set(task.id, controller)
    const assistantId = crypto.randomUUID()
    const history = (threads[task.id]?.messages ?? []).filter((message) => message.status === 'complete')
    dispatch({ type: 'submit', taskId: task.id,
      user: { id: crypto.randomUUID(), role: 'user', text, ...(images.length ? { images } : {}), status: 'complete' },
      assistant: { id: assistantId, role: 'assistant', text: '', status: 'streaming' },
    })
    const stillCurrent = () => controllers.current.get(task.id) === controller
    try {
      let completed = false
      for await (const event of adapter.stream({ sessionId: threads[task.id]?.sessionId ?? `local:${task.id}`, task, message: text, ...(images.length ? { images } : {}), history, signal: controller.signal })) {
        if (!stillCurrent()) return
        controller.signal.throwIfAborted()
        if (event.type === 'delta') dispatch({ type: 'delta', taskId: task.id, id: assistantId, text: event.text })
        else if (event.type === 'activity') dispatch({ type: 'activity', taskId: task.id, text: event.text })
        else if (event.type === 'complete') { completed = true; break }
      }
      controller.signal.throwIfAborted()
      if (!completed) throw new Error('The response stream ended before completion.')
      if (stillCurrent()) dispatch({ type: 'finish', taskId: task.id, id: assistantId, status: 'complete' })
    } catch (error) {
      if (!stillCurrent()) return
      dispatch({ type: 'finish', taskId: task.id, id: assistantId,
        status: controller.signal.aborted ? 'cancelled' : 'error',
        error: controller.signal.aborted ? undefined : error instanceof Error ? error.message : 'The chat adapter could not complete the response.',
        ...(images.length && !controller.signal.aborted ? { retryDraft: { text, images } } : {}),
      })
    } finally {
      if (stillCurrent()) controllers.current.delete(task.id)
    }
  }

  function clear(taskId: string): void {
    controllers.current.get(taskId)?.abort()
    controllers.current.delete(taskId)
    dispatch({ type: 'clear', taskId })
  }

  function restore(taskId: string, sessionId: string, messages: ChatMessage[]): void {
    controllers.current.get(taskId)?.abort()
    controllers.current.delete(taskId)
    dispatch({ type: 'restore', taskId, sessionId, messages })
  }

  return {
    threads,
    getThread: (taskId: string): TaskChat => threads[taskId] ?? emptyChat,
    setDraft: (taskId: string, value: string) => dispatch({ type: 'draft', taskId, value }),
    setImages: (taskId: string, value: ChatImageAttachment[]) => dispatch({ type: 'images', taskId, value }),
    send,
    stop: (taskId: string) => controllers.current.get(taskId)?.abort(),
    clear,
    restore,
  }
}