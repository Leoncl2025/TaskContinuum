// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { isVSCodeWidgetOpen, openVerifiedVSCodeWidget, widgetProbeId } from '../src/main/vscodeChatWidget'
import { vsCodeChatResource } from '../src/shared/vscodeChat'

const resource = vsCodeChatResource('original')
const missing = { success: false, error: 'No chat widget found. Provide sessionResource or focus a chat widget.' }
const present = { success: false, error: "No handoffs available for mode 'Agent'" }
afterEach(() => vi.useRealTimers())

it('uses an ID outside the native agent:slug format and requires a known non-executing result', async () => {
  expect(widgetProbeId).not.toContain(':')
  const probe = vi.fn(async () => missing)
  expect(await isVSCodeWidgetOpen(resource, probe)).toBe(false)
  expect(probe).toHaveBeenCalledExactlyOnceWith(resource, widgetProbeId)
  probe.mockResolvedValue(present)
  expect(await isVSCodeWidgetOpen(resource, probe)).toBe(true)
  probe.mockResolvedValue({ success: false, error: `No handoff with identifier '${widgetProbeId}' found for mode 'Custom'` })
  expect(await isVSCodeWidgetOpen(resource, probe)).toBe(true)
  probe.mockResolvedValue({ success: true, error: '' })
  await expect(isVSCodeWidgetOpen(resource, probe)).rejects.toThrow('could not be verified')
  probe.mockResolvedValue({ success: false, error: 'Unknown native result' })
  await expect(isVSCodeWidgetOpen(resource, probe)).rejects.toThrow('could not be verified')
})

it('does not treat a completed open command as a ready chat view', async () => {
  vi.useFakeTimers()
  const commands = { open: vi.fn(async () => {}), probe: vi.fn().mockResolvedValueOnce(missing).mockResolvedValueOnce(present) }
  let ready = false
  const operation = openVerifiedVSCodeWidget(resource, commands, new AbortController().signal).then(() => { ready = true })
  await vi.advanceTimersByTimeAsync(0)
  expect(commands.open).toHaveBeenCalledExactlyOnceWith(resource)
  expect(ready).toBe(false)
  await vi.advanceTimersByTimeAsync(100)
  await operation
  expect(ready).toBe(true)
  expect(commands.probe).toHaveBeenCalledTimes(2)
})

it('does not skip an explicit open when the target widget already exists', async () => {
  const commands = { open: vi.fn(async () => {}), probe: vi.fn(async () => present) }
  await openVerifiedVSCodeWidget(resource, commands, new AbortController().signal)
  expect(commands.open).toHaveBeenCalledExactlyOnceWith(resource)
  expect(commands.probe).toHaveBeenCalledExactlyOnceWith(resource, widgetProbeId)
})

it('does not acknowledge an unverified open and stops checking when cancelled', async () => {
  const abort = new AbortController()
  const commands = { open: vi.fn(async () => { abort.abort(new Error('Stopped')) }), probe: vi.fn(async () => missing) }
  await expect(openVerifiedVSCodeWidget(resource, commands, abort.signal)).rejects.toThrow('Stopped')
  expect(commands.open).toHaveBeenCalledOnce()
  expect(commands.probe).not.toHaveBeenCalled()
})

it('reports a bounded error if opening returns but the exact widget never appears', async () => {
  const commands = { open: vi.fn(async () => {}), probe: vi.fn(async () => missing) }
  await expect(openVerifiedVSCodeWidget(resource, commands, new AbortController().signal, 30)).rejects.toThrow('did not open the requested original')
  expect(commands.open).toHaveBeenCalledOnce()
})