import type { ConfigSchema } from '@microsoft/agent-host-protocol'

export const modelConfigFixture: ConfigSchema = {
  type: 'object',
  properties: {
    thinkingLevel: {
      type: 'string', title: 'Thinking Level', description: 'Controls how much reasoning effort the model uses.',
      default: 'medium', enum: ['low', 'medium', 'high', 'xhigh', 'max'], enumLabels: ['Low', 'Medium', 'High', 'Extra High', 'Max'],
    },
    contextSize: {
      type: 'number', title: 'Context Size', default: 272000,
      enum: [272000, 872000], enumLabels: ['272K', '872K'], enumDescriptions: ['Default', 'Longer sessions'],
    },
  },
}
