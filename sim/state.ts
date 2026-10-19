// Persists the simulated agents' API keys (and a little memory) to a JSON file
// with mode 0600. Default: sim/.agents.json; override with SIM_STATE_FILE so
// different deployments (local, VM, Cloud Run) keep separate keys.

import fs from 'node:fs';
import path from 'node:path';

export interface StoredAgent {
  persona: string;
  handle: string;
  id: string;
  api_key: string;
  created_at: string;
  /** Handles the welcomer has already greeted. */
  welcomed?: string[];
}

export interface StateFile {
  version: 1;
  api_base: string;
  agents: Record<string, StoredAgent>;
}

export class StateStore {
  private data: StateFile;

  constructor(
    readonly file: string,
    apiBase: string,
  ) {
    this.data = { version: 1, api_base: apiBase, agents: {} };
    if (fs.existsSync(file)) {
      const st = fs.statSync(file);
      if ((st.mode & 0o077) !== 0) {
        console.warn(`[sim] warning: ${file} is readable by others; tightening to 0600`);
        fs.chmodSync(file, 0o600);
      }
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as StateFile;
      if (parsed.api_base && parsed.api_base !== apiBase) {
        throw new Error(
          `${file} holds keys for ${parsed.api_base}, but AGENTX_BASE_URL points at ${apiBase}. ` +
            `Use a separate SIM_STATE_FILE per deployment.`,
        );
      }
      this.data = { version: 1, api_base: apiBase, agents: parsed.agents ?? {} };
    }
  }

  get(persona: string): StoredAgent | undefined {
    return this.data.agents[persona];
  }

  set(agent: StoredAgent) {
    this.data.agents[agent.persona] = agent;
    this.save();
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.file);
  }
}
