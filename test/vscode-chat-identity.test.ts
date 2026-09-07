import { describe, expect, it } from 'vitest'
import { checkedVSCodeIdentity, identityFromVSCodeBridgeUri, identityFromVSCodeHistory, vsCodeBridgeConnectUri, vsCodeChatResource } from '../src/shared/vscodeChat'

describe('original VS Code chat identity', () => {
  it('retains the native ID independently from the machine-local history root', () => {
    const workspace = 'a'.repeat(32)
    const original = identityFromVSCodeHistory(`vscode:0:${workspace}:original-session.jsonl`)
    expect(original).toEqual({ nativeSessionId: 'original-session', workspaceStorageId: workspace })
    expect(identityFromVSCodeHistory(`vscode:1:${workspace}:original-session.json`)).toEqual(original)
    expect(vsCodeChatResource(original.nativeSessionId)).toBe('vscode-chat-session://local/b3JpZ2luYWwtc2Vzc2lvbg')
  })

  it('rejects path injection, arbitrary resources, and missing workspace ownership', () => {
    expect(() => identityFromVSCodeHistory('vscode:0:workspace:../other.jsonl')).toThrow()
    expect(() => vsCodeChatResource('vscode-chat-session://local/other')).toThrow()
    expect(() => checkedVSCodeIdentity({ nativeSessionId: 'existing', workspaceStorageId: '' })).toThrow()
  })

  it.each(['vscode', 'vscode-insiders'] as const)('connects only to the original identity through %s', (scheme) => {
    const identity = { nativeSessionId: 'original-session', workspaceStorageId: 'a'.repeat(32) }
    const uri = vsCodeBridgeConnectUri(identity, scheme)
    expect(identityFromVSCodeBridgeUri(uri, scheme, identity.workspaceStorageId)).toEqual(identity)
    expect(() => identityFromVSCodeBridgeUri(uri, scheme, 'b'.repeat(32))).toThrow('different VS Code workspace')
    expect(new URL(uri).searchParams.size).toBe(2)
  })

  it('rejects connection payloads, duplicates, fragments, credentials, and other extensions', () => {
    const workspace = 'a'.repeat(32)
    const uri = vsCodeBridgeConnectUri({ nativeSessionId: 'original', workspaceStorageId: workspace })
    for (const invalid of [
      `${uri}&text=unrequested-message`, `${uri}&nativeSessionId=another`, `${uri}#send`,
      uri.replace('taskcontinuum.vscode-bridge', 'another.extension'),
      uri.replace('taskcontinuum.vscode-bridge', 'user@taskcontinuum.vscode-bridge'),
      uri.replace('/connect?', '/send?'), uri.replace('vscode:', 'https:'),
      uri.replace('nativeSessionId=original', 'nativeSessionId=..%2Fother'),
    ]) expect(() => identityFromVSCodeBridgeUri(invalid, 'vscode', workspace)).toThrow()
  })
})