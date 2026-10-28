const IDENTITIES = ['channelId', 'speakerId', 'characterId', 'worldId', 'branchId']
const BOUNDARIES = ['channelId', 'characterId', 'worldId', 'branchId']

export function normalizeMemoryContext(value) {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('memory context must be an object')
  const result = {}
  for (const key of IDENTITIES) {
    if (value[key] === undefined || value[key] === '') continue
    if (typeof value[key] !== 'string' || value[key].length > 128 || /[\u0000-\u001f]/.test(value[key])) throw new Error(`invalid memory context ${key}`)
    result[key] = value[key].trim()
  }
  if (value.knownBy !== undefined) {
    if (!Array.isArray(value.knownBy) || value.knownBy.length > 30 || value.knownBy.some(id => typeof id !== 'string' || !id.trim() || id.length > 128)) throw new Error('knownBy must contain at most 30 character identities')
    result.knownBy = [...new Set(value.knownBy)]
  }
  if (value.occurredAt !== undefined) {
    if (!Number.isFinite(Date.parse(value.occurredAt))) throw new Error('occurredAt must be an explicit ISO date/time, not a guessed scene time')
    result.occurredAt = new Date(value.occurredAt).toISOString()
  }
  return result
}

export function contextVisible(context, current) {
  if (!context) return true
  for (const key of BOUNDARIES) if (context[key] && context[key] !== current?.[key]) return false
  if (Array.isArray(context.knownBy) && context.knownBy.length && !context.knownBy.includes(current?.characterId)) return false
  return true
}

export function sameFactContext(a, b) {
  return IDENTITIES.every(key => (a?.[key] || '') === (b?.[key] || ''))
}
