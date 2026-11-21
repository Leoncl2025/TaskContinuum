import { describe, expect, it } from 'vitest'
import {
  activePaneGroup,
  closeTaskPageInGroup,
  createInitialPaneTree,
  findPaneGroup,
  findParentSplit,
  listPaneGroups,
  MAX_PANE_GROUPS,
  moveOrDropTaskPage,
  openTaskPageInGroup,
  reconcilePaneTreeWithTasks,
  removePaneGroup,
  resizePaneSplit,
  selectSessionInGroup,
  splitPaneGroup,
  swapParentSplitChildren,
  toggleParentSplitOrientation,
} from '../src/renderer/paneTree'

describe('paneTree recursive Task-Page engine', () => {
  it('clones the active Task Page and its session into a new pane while keeping the original pane intact (allowing duplicate sessions)', () => {
    const initial = createInitialPaneTree(['T-0001', 'T-0002'], 'T-0002', {
      'T-0001': 'ahp:s1',
      'T-0002': 'ahp:s2',
    }, 'g1')

    const split = splitPaneGroup(initial, 'g1', 'right', { newGroupId: 'g2', newSplitId: 'sp1' })
    const groups = listPaneGroups(split.root)
    expect(groups).toHaveLength(2)
    expect(groups.map((item) => item.id)).toEqual(['g1', 'g2'])
    expect(split.activeGroupId).toBe('g2')

    // Original pane keeps its original position, open tabs, active task, and session.
    expect(groups[0]).toMatchObject({
      id: 'g1',
      openTaskIds: ['T-0001', 'T-0002'],
      activeTaskId: 'T-0002',
      sessions: { 'T-0001': 'ahp:s1', 'T-0002': 'ahp:s2' },
    })

    // Cloned pane opens with the cloned Task Page and the exact same sessionKey!
    expect(groups[1]).toMatchObject({
      id: 'g2',
      openTaskIds: ['T-0002'],
      activeTaskId: 'T-0002',
      sessions: { 'T-0002': 'ahp:s2' },
    })

    // Switching session in g2 leaves g1's session untouched.
    const switched = selectSessionInGroup(split, 'g2', 'T-0002', 'ahp:s3')
    expect(findPaneGroup(switched.root, 'g1')?.sessions['T-0002']).toBe('ahp:s2')
    expect(findPaneGroup(switched.root, 'g2')?.sessions['T-0002']).toBe('ahp:s3')
  })

  it('supports arbitrary VS Code-style nested splits (Left/Right + child Up/Down + grandchild Left/Right) and clean branch pruning', () => {
    let tree = createInitialPaneTree(['T-0001'], 'T-0001', { 'T-0001': 'ahp:s1' }, 'g-left')
    // 1. Split right: [g-left | g-right-top]
    tree = splitPaneGroup(tree, 'g-left', 'right', { newGroupId: 'g-right-top', newSplitId: 'sp-root' })
    // 2. Nested split down inside right pane: [g-left | (g-right-top / g-right-bottom)]
    tree = splitPaneGroup(tree, 'g-right-top', 'down', { taskId: 'T-0002', sessionKey: 'ahp:s2', newGroupId: 'g-right-bottom', newSplitId: 'sp-right' })
    // 3. Nested split left inside bottom-right pane: [g-left | (g-right-top / [g-bottom-left | g-right-bottom])]
    tree = splitPaneGroup(tree, 'g-right-bottom', 'left', { taskId: 'T-0003', sessionKey: 'ahp:s3', newGroupId: 'g-bottom-left', newSplitId: 'sp-bottom' })

    expect(listPaneGroups(tree.root).map((group) => group.id)).toEqual([
      'g-left',
      'g-right-top',
      'g-bottom-left',
      'g-right-bottom',
    ])
    expect(findParentSplit(tree.root, 'g-right-top')?.orientation).toBe('vertical')
    expect(findParentSplit(tree.root, 'g-bottom-left')?.orientation).toBe('horizontal')

    // Resize, swap, and toggle orientation on nested split nodes without disturbing ancestors.
    tree = resizePaneSplit(tree, 'sp-right', 0.62)
    expect(findParentSplit(tree.root, 'g-right-top')?.ratio).toBeCloseTo(0.62, 2)
    tree = swapParentSplitChildren(tree, 'g-bottom-left')
    expect(listPaneGroups(tree.root).map((group) => group.id)).toEqual([
      'g-left',
      'g-right-top',
      'g-right-bottom',
      'g-bottom-left',
    ])
    tree = toggleParentSplitOrientation(tree, 'g-bottom-left')
    expect(findParentSplit(tree.root, 'g-bottom-left')?.orientation).toBe('vertical')

    // Closing the sole Task Page in g-bottom-left collapses sp-bottom cleanly back to g-right-bottom!
    tree = closeTaskPageInGroup(tree, 'g-bottom-left', 'T-0003')
    expect(listPaneGroups(tree.root).map((group) => group.id)).toEqual([
      'g-left',
      'g-right-top',
      'g-right-bottom',
    ])
    expect(tree.activeGroupId).toBe('g-right-bottom')
  })

  it('reorders Task Pages within a pane and drags/moves Task Pages across panes or onto edges for nested splits', () => {
    let tree = createInitialPaneTree(['T-0001', 'T-0002', 'T-0003'], 'T-0001', {
      'T-0001': 'ahp:a',
      'T-0002': 'ahp:b',
    }, 'g1')

    // Reorder T-0003 to the front of g1.
    tree = moveOrDropTaskPage(
      tree,
      { sourceGroupId: 'g1', taskId: 'T-0003' },
      { targetGroupId: 'g1', zone: 'tab', insertIndex: 0 },
    )
    expect(findPaneGroup(tree.root, 'g1')?.openTaskIds).toEqual(['T-0003', 'T-0001', 'T-0002'])

    // Drag T-0002 onto the right edge of g1 -> moves T-0002 out of g1 into new right pane g2!
    tree = moveOrDropTaskPage(
      tree,
      { sourceGroupId: 'g1', taskId: 'T-0002' },
      { targetGroupId: 'g1', zone: 'right' },
      { newGroupId: 'g2', newSplitId: 'sp1' },
    )
    expect(findPaneGroup(tree.root, 'g1')?.openTaskIds).toEqual(['T-0003', 'T-0001'])
    expect(findPaneGroup(tree.root, 'g2')).toMatchObject({
      openTaskIds: ['T-0002'],
      activeTaskId: 'T-0002',
      sessions: { 'T-0002': 'ahp:b' },
    })

    // Drag T-0002 from g2 back into g1's tab bar at index 1 -> g2 auto-collapses because it had no other tabs!
    tree = moveOrDropTaskPage(
      tree,
      { sourceGroupId: 'g2', taskId: 'T-0002' },
      { targetGroupId: 'g1', zone: 'tab', insertIndex: 1 },
    )
    expect(listPaneGroups(tree.root)).toHaveLength(1)
    expect(activePaneGroup(tree).openTaskIds).toEqual(['T-0003', 'T-0002', 'T-0001'])
    expect(activePaneGroup(tree).activeTaskId).toBe('T-0002')
  })

  it('enforces MAX_PANE_GROUPS and reconciles deleted workspace tasks cleanly', () => {
    let tree = createInitialPaneTree(['T-0001'], 'T-0001', {}, 'g0')
    for (let i = 1; i < MAX_PANE_GROUPS + 2; i++) {
      tree = splitPaneGroup(tree, tree.activeGroupId, i % 2 === 0 ? 'down' : 'right', { newGroupId: `g${i}` })
    }
    expect(listPaneGroups(tree.root)).toHaveLength(MAX_PANE_GROUPS)

    tree = openTaskPageInGroup(tree, 'g1', 'T-9999')
    const reconciled = reconcilePaneTreeWithTasks(tree, new Set(['T-0001']), 'T-0001')
    expect(findPaneGroup(reconciled.root, 'g1')?.openTaskIds).toEqual(['T-0001'])

    const closed = removePaneGroup(reconciled, 'g1')
    expect(listPaneGroups(closed.root)).toHaveLength(MAX_PANE_GROUPS - 1)
  })
})
