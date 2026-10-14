import type { ChatLinkReply } from '../../shared/chatLinks'

export class ChatLinkFailure extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}
export function chatLinkResult<T>(reply: ChatLinkReply<T>): T {
  if (!reply.ok) throw new ChatLinkFailure(reply.error.code, reply.error.message)
  return reply.result
}
