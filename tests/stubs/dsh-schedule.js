// A fake Host schedule service for work order E. The real service lives in
// packages/schedule/schedule/src (types.ts / index.ts): `create` returns a catalog
// entry, `list` returns a *page object* (`{items,shown,total,limit,offset}`, not an
// array), and `edit({id,action:'delete'})` removes a task. Every call is recorded so
// a test can assert both the request shape and the number of mutations.
//
// Errors are injected per call: pass a function to fail only some requests (the
// pass handles one conversation at a time, so a test needs "this session throws
// subagent_session, that one throws internal_error, the third succeeds").
function maybeThrow(source, request) {
  const error = typeof source === 'function' ? source(request) : source
  if (error) throw error
  return undefined
}

export function scheduleError(code, message = code) {
  const error = new Error(message)
  error.code = code
  return error
}

export function fakeScheduleService({ createError = null, listError = null, editError = null } = {}) {
  const tasks = []
  const calls = { create: [], list: [], edit: [] }
  let seq = 0

  return {
    tasks,
    calls,
    /** Seeds a task the sweep should discover (active/paused/ended). */
    seed(task) {
      const entry = {
        id: task.id || `sched-seed-${++seq}`,
        title: task.title,
        prompt: task.prompt || '',
        status: task.status || 'active',
        target: task.target || { kind: 'session', sessionId: 'seed' },
        kind: 'at',
        createdAt: new Date().toISOString(),
      }
      tasks.push(entry)
      return entry
    },
    /** Flips a stored task's status, the way a delivery or a user pause would. */
    setStatus(id, status) {
      const task = tasks.find((item) => item.id === id)
      if (!task) throw new Error(`no such task ${id}`)
      task.status = status
      return task
    },
    taskByTitle(title) {
      return tasks.find((item) => item.title === title) || null
    },
    async create(request) {
      calls.create.push(request)
      maybeThrow(createError, request)
      const entry = {
        id: `sched-${++seq}`,
        title: request.title,
        prompt: request.prompt,
        status: 'active',
        kind: request.timing?.kind || null,
        target: request.target || null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      tasks.push(entry)
      return entry
    },
    async list(request = {}) {
      calls.list.push(request)
      maybeThrow(listError, request)
      const limit = Number(request.limit) || 100
      const offset = Number(request.offset) || 0
      const matching = tasks.filter((item) => request.active === undefined || (item.status === 'active') === request.active)
      const items = matching.slice(offset, offset + limit)
      return { items, shown: items.length, total: matching.length, limit, offset }
    },
    async edit(request) {
      calls.edit.push(request)
      maybeThrow(editError, request)
      const index = tasks.findIndex((item) => item.id === request.id)
      if (index < 0) return { id: request.id, code: 'schedule_not_found' }
      if (request.action === 'delete') {
        tasks.splice(index, 1)
        return { id: request.id, deleted: true }
      }
      const task = tasks[index]
      if (request.patch?.title !== undefined) task.title = request.patch.title
      if (request.patch?.prompt !== undefined) task.prompt = request.patch.prompt
      if (request.patch?.active === false) task.status = 'paused'
      if (request.patch?.active === true) task.status = 'active'
      return { ...task }
    },
  }
}

/** A cordis-shaped context whose only service is the fake schedule. */
export function wakeContext(schedule) {
  return {
    get(name) {
      return name === 'schedule' ? schedule : undefined
    },
  }
}

/**
 * The 0.2.0 / 0.2.1 session-scoped reminder API: every task belongs to one
 * Session, `list` needs that Session, and there is no `edit` method. The wake
 * pass probes for `edit` to tell this shape from the 0.2.2 host-wide task table,
 * so this fake exists to pin that the old API is skipped instead of being
 * called with the wrong argument shape.
 */
export function fakeSessionScheduleService() {
  const tasks = []
  const calls = { create: [], list: [], delete: [] }
  let seq = 0

  return {
    tasks,
    calls,
    async create(sessionId, request) {
      calls.create.push({ sessionId, request })
      const entry = { id: `sess-sched-${++seq}`, sessionId, title: request.title, status: 'active' }
      tasks.push(entry)
      return entry
    },
    async list(request) {
      calls.list.push(request)
      return tasks.filter((task) => task.sessionId === request.sessionId)
    },
    async delete(request) {
      calls.delete.push(request)
      const index = tasks.findIndex((task) => task.id === request.id && task.sessionId === request.sessionId)
      if (index < 0) return { id: request.id, deleted: false }
      tasks.splice(index, 1)
      return { id: request.id, deleted: true }
    },
  }
}
