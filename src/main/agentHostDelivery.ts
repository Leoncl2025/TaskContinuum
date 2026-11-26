import { z } from 'zod'

export const SUBMIT_TURN_METHOD = 'taskcontinuum/submitTurn'
export const TURN_DELIVERY_CAPABILITY = { taskcontinuumTurnDelivery: 1 } as const

const rejectionMessages = {
  models: 'No turn was sent. The model or its configuration was rejected by the owner Host.',
  authorization: 'No turn was sent. Access to the owner chat changed.',
  validation: 'No turn was sent. The turn parameters were rejected before dispatch.',
  unavailable: 'No turn was sent. The owner chat was not ready for this message.',
} as const

export type TurnRejectionReason = keyof typeof rejectionMessages

export const turnDeliveryReceiptSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('confirmed'), turnId: z.uuid() }).strict(),
  z.object({ status: z.literal('rejected'), turnId: z.uuid(), reason: z.enum(['models', 'authorization', 'validation', 'unavailable']) }).strict(),
])

export class AgentHostTurnNotDispatchedError extends Error {
  constructor(readonly reason: TurnRejectionReason, options?: ErrorOptions) {
    super(rejectionMessages[reason], options)
    this.name = 'AgentHostTurnNotDispatchedError'
  }

  static fromSendPhase(phase: string, cause: unknown): AgentHostTurnNotDispatchedError {
    return new AgentHostTurnNotDispatchedError(
      phase === 'models' || phase === 'authorization' || phase === 'validation' ? phase : 'unavailable',
      { cause },
    )
  }
}
