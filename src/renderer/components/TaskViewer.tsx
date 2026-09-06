import { useState } from 'react'
import type { TaskRecord, TaskStatus } from '../../shared/tasks'
import { statusLabels, taskProgress } from '../../shared/tasks'
import { Icon } from './Primitives'

const tabs = ['Overview', 'Requirements', 'Plan', 'Checklist'] as const

export function TaskViewer({ task, onCheck, onStatus, onChat }: { task: TaskRecord; onCheck(id: string): void; onStatus(status: TaskStatus): void; onChat(): void }) {
  const [tab, setTab] = useState<typeof tabs[number]>('Overview')
  const progress = taskProgress(task)
  const checked = task.checklist.filter((item) => item.done).length

  function checklist(limit?: number) {
    return <ul className="acceptance-list">{task.checklist.slice(0, limit).map((item) => <li key={item.id}><label><input type="checkbox" checked={item.done} onChange={() => onCheck(item.id)} /><span className={item.done ? 'criterion-complete' : ''}>{item.title}</span><small>{item.id}</small></label></li>)}</ul>
  }

  return <div className="task-viewer" aria-label="Task viewer">
    <div className="breadcrumbs"><span>Task Continuum</span><Icon name="chevron-right" /><span>Tasks</span><Icon name="chevron-right" /><strong>{task.id}</strong></div>
    <div className="detail-tabs" role="tablist" aria-label="Task documents">
      {tabs.map((value, index) => <button type="button" key={value} id={`tab-${value}`} role="tab" aria-selected={tab === value} aria-controls="task-document" tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} onKeyDown={(event) => {
        const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : undefined
        if (next !== undefined) { event.preventDefault(); setTab(tabs[next]); document.getElementById(`tab-${tabs[next]}`)?.focus() }
      }}>{value}{value === 'Checklist' && <span>{checked}/{task.checklist.length}</span>}</button>)}
    </div>
    <article id="task-document" className="task-document" role="tabpanel" aria-labelledby={`tab-${tab}`} tabIndex={0}>
      <div className="task-eyebrow"><span>{task.kind}</span><span>{task.id}</span><span className="sample-label">Sample task</span></div>
      <h1>{task.title}</h1>
      <p className="task-summary">{task.summary}</p>
      <div className="metadata-row">
        <label className={`status-select status-${task.status}`}><span className="status-dot" /><select aria-label="Task status" value={task.status} onChange={(event) => onStatus(event.target.value as TaskStatus)}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <span className="meta-item"><Icon name="flag" />{task.priority}</span>
        <span className="meta-item"><span className="avatar small">Y</span>{task.owner}</span>
        <button type="button" className="text-button ask-task" onClick={onChat}><Icon name="comment-discussion" />Discuss task</button>
      </div>
      <div className="progress-summary"><span>Acceptance progress</span><strong>{progress}%</strong><progress aria-label="Task acceptance progress" value={progress} max={100} /></div>
      {tab === 'Overview' && <>
        <section className="document-section"><h2>The goal</h2><p>{task.goal}</p></section>
        <section className="next-action"><span className="next-action-icon"><Icon name="arrow-right" /></span><div><h2>Next action</h2><p>{task.nextAction}</p></div></section>
        <section className="document-section"><div className="section-heading"><h2>Acceptance criteria</h2><button type="button" className="text-button" onClick={() => setTab('Checklist')}>View all <Icon name="arrow-right" /></button></div>{checklist(3)}</section>
        <div className="document-note"><Icon name="info" /><p>This is sample data. Status and checklist edits do not change your real planning repository.</p></div>
      </>}
      {tab === 'Requirements' && <section className="document-section"><h2>What success looks like</h2><p>{task.goal}</p><ol className="requirements-list">{task.requirements.map((item, index) => <li key={item}><span>FR-{String(index + 1).padStart(2, '0')}</span><p>{item}</p></li>)}</ol></section>}
      {tab === 'Plan' && <section className="document-section"><h2>A path forward</h2><p>Small, verifiable steps. Keep the task in focus.</p><ol className="plan-list">{task.plan.map((item, index) => <li key={item}><span>{index + 1}</span><div><strong>{item}</strong><small>Sample plan · not an execution report</small></div></li>)}</ol><div className="next-action"><Icon name="arrow-right" /><p>{task.nextAction}</p></div></section>}
      {tab === 'Checklist' && <section className="document-section"><h2>Acceptance checklist</h2><p>{checked} of {task.checklist.length} criteria checked. Changes are local to this demo.</p>{checklist()}{!task.checklist.length && <p className="muted">This new demo task has no acceptance criteria yet.</p>}</section>}
    </article>
  </div>
}