const vscode = require('vscode')
const { readFile } = require('node:fs/promises')
const { createHash } = require('node:crypto')
const { fileURLToPath } = require('node:url')

exports.activate = (context) => {
  const participant = vscode.chat.createChatParticipant('taskcontinuum.delivery-test', async (request, _history, stream) => {
    const matched = request.prompt.includes('Task Continuum message ID:') && request.prompt.includes('TASKCONTINUUM_ORIGINAL_SEND_OK')
    const expectedImage = /TASKCONTINUUM_IMAGE_SHA256: ([a-f0-9]{64})/.exec(request.prompt)
    if (expectedImage) {
      const files = [...request.prompt.matchAll(/^- Image \d+: (file:\/\/[^\r\n]+)$/gm)]
      if (files.length !== 1) { stream.markdown('TASKCONTINUUM_IMAGE_MISSING'); return }
      try {
        const image = await readFile(fileURLToPath(files[0][1]))
        if (createHash('sha256').update(image).digest('hex') !== expectedImage[1]) { stream.markdown('TASKCONTINUUM_IMAGE_MISMATCH'); return }
      } catch { stream.markdown('TASKCONTINUUM_IMAGE_UNREADABLE'); return }
    }
    stream.markdown(matched ? 'TASKCONTINUUM_ORIGINAL_SEND_OK' : 'TASKCONTINUUM_TEST_PARTICIPANT_READY')
  })
  context.subscriptions.push(participant)
  context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider('taskcontinuum-test', {
    provideLanguageModelChatInformation: () => [{
      id: 'deterministic', name: 'Task Continuum Deterministic', family: 'taskcontinuum-test', version: '1',
      maxInputTokens: 128000, maxOutputTokens: 4096, capabilities: { toolCalling: true },
    }],
    provideLanguageModelChatResponse: async (_model, messages, _options, progress, token) => {
      if (token.isCancellationRequested) return
      const text = messages.flatMap((message) => message.content).filter((part) => part instanceof vscode.LanguageModelTextPart).map((part) => part.value).join('\n')
      const response = text.includes('Task Continuum message ID:') && text.includes('Original bridge question')
        ? 'TASKCONTINUUM_ORIGINAL_SEND_OK'
        : 'TASKCONTINUUM_TEST_MODEL_READY'
      progress.report(new vscode.LanguageModelTextPart(response))
    },
    provideTokenCount: async (_model, text) => Math.ceil((typeof text === 'string' ? text.length : JSON.stringify(text).length) / 4),
  }))
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left)
  context.subscriptions.push(status)
  status.command = 'taskcontinuumTest.disableSendConfirmation'
  context.subscriptions.push(vscode.commands.registerCommand(status.command, async () => {
    await vscode.workspace.getConfiguration('taskcontinuum').update('confirmOriginalSessionSend', false, vscode.ConfigurationTarget.Global)
    status.text = 'Delivery confirmation disabled'
  }))
  void vscode.lm.selectChatModels({ vendor: 'taskcontinuum-test' }).then(async (models) => {
    await vscode.commands.executeCommand('workbench.action.chat.getHandoffs')
    status.text = models.length ? 'Test model ready' : 'Test model missing'
    status.show()
  })
}