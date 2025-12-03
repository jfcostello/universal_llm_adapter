import path from 'path';
import fs from 'fs';

export function withLiveEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, LLM_LIVE: '1', ...overrides };
}

export function buildLogPathFor(testFileBase: string): string {
  const dateOnly = new Date().toISOString().split('T')[0];
  return path.join(process.cwd(), 'tests', 'live', 'logs', `${dateOnly}-${testFileBase}.log`);
}

export function redactionFoundIn(text: string): boolean {
  // Provider-agnostic: detect any redaction marker of the form ***XXXX
  return /\*{3}[A-Za-z0-9_-]{4}/.test(text);
}

export type BaseSpec = {
  messages: any[];
  llmPriority: Array<{ provider: string; model: string }>;
  settings: Record<string, any>;
  functionToolNames?: string[];
  mcpServers?: string[];
  metadata?: Record<string, any>;
  toolChoice?: any;
};

export function makeSpec(base: BaseSpec): BaseSpec {
  return base; // pass-through helper for clarity/extensibility
}

/**
 * Merge test settings with config settings.
 * Config temperature always wins - tests should not override provider-specific temperature settings.
 * This allows providers with temperature restrictions (like openai-responses) to work correctly.
 */
export function mergeSettings(
  configSettings: Record<string, any>,
  testOverrides: Record<string, any>
): Record<string, any> {
  const result = { ...configSettings, ...testOverrides };
  // Config temperature always takes precedence - don't let tests override it
  // This ensures provider-specific temperature requirements are respected
  if (configSettings.temperature !== undefined) {
    result.temperature = configSettings.temperature;
  } else if (testOverrides.temperature !== undefined) {
    // If config doesn't have temperature, don't add it from test overrides
    delete result.temperature;
  }
  return result;
}

// Parse JSON bodies from the raw test log file
export function parseLogBodies(logPath: string): any[] {
  if (!fs.existsSync(logPath)) return [];
  const text = fs.readFileSync(logPath, 'utf-8');
  const lines = text.split(/\r?\n/);
  const bodies: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].includes('--- BODY ---')) {
      i++;
      const buf: string[] = [];
      while (i < lines.length && !/^={10,}$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      const jsonStr = buf.join('\n').trim();
      if (jsonStr.startsWith('{') || jsonStr.startsWith('[')) {
        try { bodies.push(JSON.parse(jsonStr)); } catch {}
      }
    }
    i++;
  }
  return bodies;
}

export function findLatestRandomValue(bodies: any[]): string | null {
  for (let i = bodies.length - 1; i >= 0; i--) {
    const body = bodies[i];
    const msgs = body?.messages || [];
    for (const m of msgs) {
      if (m.role === 'tool' && Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part?.type === 'tool_result' && part?.toolName === 'test.random') {
            const val = part?.result?.randomValue;
            if (typeof val === 'number' || typeof val === 'string') return String(val);
          }
        }
      }
    }
  }
  return null;
}

export function parseStream(stdout: string): any[] {
  const events: any[] = [];
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj === 'object') events.push(obj);
    } catch {}
  }
  return events;
}

export function collectDeltaText(events: any[]): string {
  return events
    .filter(e => e.type === 'DELTA' && typeof e.content === 'string')
    .map(e => e.content)
    .join('');
}

export function findDone(events: any[]): any | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'DONE') return events[i];
  }
  return undefined;
}
