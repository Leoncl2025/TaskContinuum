const vscode = require('vscode')

exports.activate = (context) => {
  const participant = vscode.chat.createChatParticipant('taskcontinuum.delivery-test', async (request, _history, stream) => {
    const matched = request.prompt.includes('Task Continuum message ID:') && request.prompt.includes('TASKCONTINUUM_ORIGINAL_SEND_OK')
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