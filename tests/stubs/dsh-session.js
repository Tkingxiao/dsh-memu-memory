// The host exports buildForkSeed from @deepseek-ai/dsh-session. Consolidation
// forks a seeded copy of the transcript, so the fork builder is on the critical
// path of every agent-backend consolidation — without a stub here those tests
// could only ever exercise the "fork builder unavailable" failure branch.
export function buildForkSeed(events, lastSeq) {
  return { seeded: true, events, lastSeq }
}
