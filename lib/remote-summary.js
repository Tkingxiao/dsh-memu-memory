import { getSummaryConfig } from './memu-config.js'
import { loadPromptForDomain, CONSOLIDATION_CONTRACTS } from './prompts.js'
import { getSettings } from './state.js'

function parseJsonObject(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  try { return JSON.parse(raw) } catch {}
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(raw.slice(start, end + 1)) } catch { return null }
}

function cleanMemories(value) {
  const list = Array.isArray(value) ? value : []
  return list
    .map((m) => ({
      title: String(m?.title || '').trim().slice(0, 120),
      content: String(m?.content || '').trim(),
      tags: Array.isArray(m?.tags) ? m.tags.slice(0, 20).map((t) => String(t)) : [],
      openLoop: m?.open_loop === true || m?.openLoop === true,
      confidence: Number.isFinite(Number(m?.confidence)) ? Number(m.confidence) : 0.8,
      layer: ['long_term', 'short_term'].includes(m?.layer) ? m.layer : 'long_term',
      disclosure: ['can_tell', 'only_if_asked', 'never_say'].includes(m?.disclosure) ? m.disclosure : 'can_tell',
      visibility: ['shared', 'session', 'secret'].includes(m?.visibility) ? m.visibility : 'session',
      owner: ['me', 'us', 'about_user', 'about_project'].includes(m?.owner) ? m.owner : 'me',
      source: ['user_said', 'inferred', 'imagined', 'told'].includes(m?.source) ? m.source : 'inferred',
      moodValence: Number.isFinite(m?.mood_valence) ? Math.max(-1, Math.min(1, m.mood_valence)) : null,
      arousal: Number.isFinite(m?.arousal) ? Math.max(0, Math.min(1, m.arousal)) : null,
      peak: m?.peak === true,
      salientDate: typeof m?.salient_date === 'string' ? m.salient_date : null,
    }))
    .filter((m) => m.content)
    .slice(0, 20)
}

// Remote mode: the configured chat endpoint does the summarizing. The session
// agent is not prompted, so a remote key can be used without loading the local
// tool chain or installing anything.
export async function summarizeRemote({ transcript, libraryName, domain, signal, timeoutMs = 180_000 } = {}) {
  const config = getSummaryConfig({ withKey: true })
  if (!config.baseUrl) throw new Error('remote summary base URL is not configured')
  if (!config.model) throw new Error('remote summary model is not configured')
  if (!config.apiKey) throw new Error('remote summary API key is not configured')
  // Same prompt body as the local path; the JSON contract and the transcript are
  // appended here because only this path needs them.
  const prompt = [
    loadPromptForDomain('private-consolidation', {
      libraryName: libraryName || '(unbound)',
      domain: domain || 'general',
      mustRememberCap: getSettings().mustRememberCap,
    }, domain || 'general').text,
    '',
    CONSOLIDATION_CONTRACTS.remote,
    '',
    '---',
    '对话记录：',
    String(transcript || '').slice(0, 90_000),
  ].join('\n')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = () => controller.abort()
  signal?.addEventListener?.('abort', onAbort, { once: true })
  try {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.4,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    })
    const body = await res.text()
    if (!res.ok) throw new Error(`remote summary failed (HTTP ${res.status}); provider response omitted to protect credentials`)
    let data = null
    try { data = JSON.parse(body) } catch {}
    const text = data?.choices?.[0]?.message?.content
    const parsed = parseJsonObject(text)
    if (!parsed) throw new Error(`remote summary returned non-JSON: ${String(text || body).slice(0, 600)}`)
    return cleanMemories(parsed.memories)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

export { cleanMemories, parseJsonObject }
