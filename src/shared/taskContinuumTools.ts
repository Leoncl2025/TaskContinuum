export const TASKCONTINUUM_TOOL_NAMESPACE = 'taskcontinuum'

export const collaborationToolIds = {
  listSessions: { operation: 'list_sessions', legacyName: 'tc_sessions_list' },
  readContext: { operation: 'read_context', legacyName: 'tc_sessions_context' },
  sendMessage: { operation: 'send_message', legacyName: 'tc_messages_send' },
  messageStatus: { operation: 'message_status', legacyName: 'tc_messages_status' },
} as const

export function taskContinuumToolName<Category extends string, Operation extends string>(category: Category, operation: Operation) {
  return `${TASKCONTINUUM_TOOL_NAMESPACE}_${category}_${operation}` as const
}

export function collaborationToolMatches(name: string, id: keyof typeof collaborationToolIds): boolean {
  const tool = collaborationToolIds[id]
  return name === tool.legacyName || name === taskContinuumToolName('collaboration', tool.operation)
}
