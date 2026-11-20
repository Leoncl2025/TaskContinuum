import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { agentHostKey } from '../shared/agentHost'
import type { DesktopInfo, DesktopWindowContext } from '../shared/desktop'
import { useSessionTitles } from './chat/useSessionTitles'
import { AgentHostPanel } from './components/AgentHostPanel'
import { Icon, IconButton } from './components/Primitives'
import { UpdateNotice } from './components/UpdateSettings'
import type { useUpdates } from './components/UpdateSettings'
import { readLayout, saveLayout } from './layout'
import { machineLabel, useMachineAliases } from './machineAliases'
import { MachineAliasesProvider } from './MachineAliasesProvider'
import appIcon from '../../build/icon.png'

type SessionContext = Extract<DesktopWindowContext, { kind: 'session' }>

export function SessionWindowApp({ context, updates, updateSafetyError }: {
  context: SessionContext
  updates: ReturnType<typeof useUpdates>
  updateSafetyError?: string
}) {
  return <MachineAliasesProvider workspaceId={context.workspaceId}>
    <SessionWindowShell context={context} updates={updates} updateSafetyError={updateSafetyError} />
  </MachineAliasesProvider>
}

function SessionWindowShell({ context, updates, updateSafetyError }: {
  context: SessionContext
  updates: ReturnType<typeof useUpdates>
  updateSafetyError?: string
}) {
  const aliases = useMachineAliases()
  const sessionTitles = useSessionTitles(context.workspaceId)
  const [theme, setTheme] = useState<'dark' | 'light'>(() => readLayout().theme)
  const [chatHeaderTarget, setChatHeaderTarget] = useState<HTMLDivElement | null>(null)
  const [desktop, setDesktop] = useState<DesktopInfo>()
  const [fullScreen, setFullScreen] = useState(false)
  const [desktopError, setDesktopError] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [docking, setDocking] = useState(false)
  const draftRef = useRef(context.initialDraft ?? '')
  const initialDraft = useMemo(
    () => context.initialDraft ? { nonce: 1, text: context.initialDraft } : undefined,
    [context.initialDraft],
  )
  const handleDraftChange = useCallback((value: string) => {
    draftRef.current = value
  }, [])

  useEffect(() => {
    const onStorage = () => {
      const next = readLayout().theme
      setTheme((current) => current === next ? current : next)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  useEffect(() => {
    let mounted = true
    let changed = false
    const bridge = window.desktop
    const unlisten = bridge?.onFullScreenChanged((value) => { changed = true; if (mounted) setFullScreen(value) })
    void bridge?.getInfo().then((info) => { if (mounted) setDesktop(info) }).catch(() => { if (mounted) setDesktopError(true) })
    void bridge?.getFullScreen().then((value) => { if (mounted && !changed) setFullScreen(value) }).catch(() => { if (mounted) setDesktopError(true) })
    return () => { mounted = false; unlisten?.() }
  }, [])

  function toggleTheme(): void {
    const current = readLayout()
    const nextTheme = current.theme === 'dark' ? 'light' : 'dark'
    saveLayout({ ...current, theme: nextTheme })
    setTheme(nextTheme)
  }

  function windowAction(action: 'minimize' | 'toggleMaximize' | 'toggleFullScreen' | 'close'): void {
    void window.desktop?.[action]().catch(() => setDesktopError(true))
  }

  async function dockToMainWindow(): Promise<void> {
    if (docking) return
    setDocking(true)
    setActionError(null)
    try {
      const draft = draftRef.current.trim() ? draftRef.current : undefined
      await window.desktop?.windows?.dock(draft ? { draft } : undefined)
    } catch (failure) {
      setDocking(false)
      setActionError(failure instanceof Error ? failure.message : 'Could not dock session back into the main window.')
    }
  }

  const cachedTitle = sessionTitles.titles[agentHostKey(context.target)]
  const ownerDisplay = machineLabel(context.target.owner, aliases)

  return <div className="workbench session-window" data-theme={theme} data-compact={false}>
    <header className="titlebar session-window-titlebar" aria-label="Session window toolbar" data-chat-header={true}>
      <div className="app-brand session-window-brand">
        <span className="brand-mark"><img src={appIcon} alt="" width={20} height={20} /></span>
        <span className="session-window-task-pill" title={`${context.task.id} · ${context.task.title}`}>{context.task.id}</span>
      </div>
      <div className="titlebar-chat" ref={setChatHeaderTarget} />
      <div className="titlebar-actions">
        <button type="button" className="session-window-dock-button" aria-label="Dock session to main window" title="Dock session back into the main window" disabled={docking} onClick={() => { void dockToMainWindow() }}>
          <Icon name="layout-panel-dock" />
          <span>Dock</span>
        </button>
        <IconButton icon="color-mode" label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={toggleTheme} />
      </div>
      {window.desktop && <div className="window-controls">
        <IconButton icon={fullScreen ? 'screen-normal' : 'screen-full'} label={fullScreen ? 'Exit full screen' : 'Enter full screen'} title={`${fullScreen ? 'Exit' : 'Enter'} full screen (F11 / Shift+Alt+Enter)`} aria-pressed={fullScreen} onClick={() => windowAction('toggleFullScreen')} />
        <IconButton icon="chrome-minimize" label="Minimize window" onClick={() => windowAction('minimize')} />
        <IconButton icon="chrome-maximize" label="Maximize or restore window" disabled={fullScreen} onClick={() => windowAction('toggleMaximize')} />
        <IconButton icon="chrome-close" label="Close window" onClick={() => windowAction('close')} />
      </div>}
    </header>

    {updateSafetyError && <div className="copilot-banner copilot-error" role="alert"><Icon name="error" /><span>{updateSafetyError}</span></div>}
    {actionError && <div className="copilot-banner copilot-error" role="alert"><Icon name="error" /><span>{actionError}</span><IconButton icon="close" label="Dismiss session window error" onClick={() => setActionError(null)} /></div>}

    <main className="main-panel session-window-main" aria-label="Standalone session workspace">
      <AgentHostPanel
        task={context.task}
        target={context.target}
        headerTarget={chatHeaderTarget}
        cachedTitle={cachedTitle}
        onTitles={sessionTitles.remember}
        active={true}
        hideClose={true}
        restoredDraft={initialDraft}
        onDraftChange={handleDraftChange}
        onDetach={() => { void dockToMainWindow() }}
        onClose={() => { void dockToMainWindow() }}
        onBusy={setBusy}
      />
    </main>

    <footer className="statusbar" aria-label="Session window status">
      <span className="local-status"><Icon name="multiple-windows" />SESSION WINDOW</span>
      <span title={context.workspaceRoot}><Icon name="folder" />{context.workspaceName}</span>
      <span className="session-window-status-task" title={context.task.title}>{context.task.id} · {context.task.title}</span>
      <span className="statusbar-spacer" />
      <span className="response-status" role="status" title={context.target.owner.machineName}>{busy ? 'Agent Host active' : `Agent Host @ ${ownerDisplay}`}</span>
      <button type="button" disabled={docking} onClick={() => { void dockToMainWindow() }}><Icon name="layout-panel-dock" />Dock to main window</button>
      <span className="platform-status">{desktopError ? 'Desktop bridge error' : desktop ? `Desktop · ${desktop.version}` : 'Desktop'}</span>
    </footer>

    <UpdateNotice updates={updates} />
  </div>
}
