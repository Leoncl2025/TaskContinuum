import { describe, expect, it } from 'vitest'
import { buildTaskTree } from '../src/shared/taskTree'
import type { TaskTreeNode } from '../src/shared/taskTree'
import type { TaskRecord } from '../src/shared/tasks'

function task(id: string, parentId?: string): TaskRecord {
  return { id, parentId, title: id, kind: 'feature', status: 'backlog', priority: 'P2', owner: 'Owner', summary: '', goal: '', nextAction: '', requirements: [], plan: [], checklist: [] }
}

function ids(nodes: TaskTreeNode[]): string[] {
  return nodes.flatMap((node) => [node.task.id, ...ids(node.children)])
}

describe('task hierarchy', () => {
  it('groups grandchildren under their parent rather than directory order', () => {
    const tree = buildTaskTree([task('T-0001'), task('T-0002', 'T-0001'), task('T-0003', 'T-0001'), task('T-0005', 'T-0002')])
    expect(ids(tree)).toEqual(['T-0001', 'T-0002', 'T-0005', 'T-0003'])
    expect(tree[0].children[0].children[0].task.id).toBe('T-0005')
  })

  it('handles children appearing before parents and multiple independent roots', () => {
    const tree = buildTaskTree([task('child', 'root'), task('other-root'), task('root'), task('orphan', 'missing')])
    expect(ids(tree)).toEqual(['other-root', 'root', 'child', 'orphan'])
    expect(tree.map((node) => node.task.id)).toEqual(['other-root', 'root', 'orphan'])
  })

  it('retains the ancestor chain of a matching child without unrelated siblings', () => {
    const tree = buildTaskTree([task('root'), task('parent', 'root'), task('sibling', 'root'), task('leaf', 'parent')], new Set(['leaf']))
    expect(ids(tree)).toEqual(['root', 'parent', 'leaf'])
    expect(tree[0].matches).toBe(false)
    expect(tree[0].children[0].children[0].matches).toBe(true)
    expect(buildTaskTree([task('root')], new Set())).toEqual([])
  })

  it('keeps malformed cyclic and self-parented tasks visible exactly once', () => {
    const tree = buildTaskTree([task('first', 'second'), task('second', 'first'), task('self', 'self'), task('child', 'first')])
    expect(ids(tree).sort()).toEqual(['child', 'first', 'second', 'self'])
    expect(ids(buildTaskTree([task('first', 'second'), task('second', 'first')], new Set(['second'])))).toEqual(['first', 'second'])
  })
})