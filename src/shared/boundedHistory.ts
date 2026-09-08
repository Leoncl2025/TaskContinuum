import type { ChatMessage } from './chat'

export function boundedHistory(messages: ChatMessage[], maximum = 60000): { messages: ChatMessage[]; truncated: boolean; omittedMessages: number } {
  const selected: ChatMessage[] = []
  let remaining = maximum
  let truncated = false
  for (const message of [...messages].reverse()) {
    if (remaining <= 0 || selected.length >= 500) { truncated = true; break }
    const marker = '[Earlier text omitted]\n'
    const prefix = remaining > marker.length ? marker : ''
    const text = message.text.length > remaining ? `${prefix}${message.text.slice(-(remaining - prefix.length))}` : message.text
    truncated ||= text !== message.text
    selected.unshift({ ...message, text })
    remaining -= text.length
  }
  return { messages: selected, truncated, omittedMessages: messages.length - selected.length }
}