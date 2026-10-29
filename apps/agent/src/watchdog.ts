import type { AgentJournal } from './journal.js';
import { spawnTool } from '../../../packages/connectors/src/runtime/spawn-tool.js';
export async function resumePaused(
  journal: AgentJournal,
  allowed: Readonly<Record<string, { root: string; units: readonly string[] }>>,
) {
  for (const [resourceId, units] of Object.entries(journal.state.paused)) {
    for (const unit of Object.keys(units)) {
      const policy = allowed[resourceId];
      if (!policy?.units.includes(unit)) {
        await journal.record({ kind: 'incident', resourceId, unit });
        continue;
      }
      try {
        const r = await spawnTool('systemctl', ['start', unit], {
          cwd: policy.root,
          timeoutMs: 30000,
          diagnosticLimit: 4096,
        });
        if (r.exitCode !== 0 || r.timedOut) throw new Error('Resume failed');
        await journal.record({ kind: 'resumed', resourceId, unit });
      } catch {
        await journal.record({ kind: 'incident', resourceId, unit });
      }
    }
  }
  return Object.keys(journal.state.paused).length === 0;
}
