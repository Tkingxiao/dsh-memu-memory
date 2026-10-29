import crypto from 'node:crypto'

export function createUserMessage(input) {
  return { id: crypto.randomUUID(), role: 'user', ...input }
}
