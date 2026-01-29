export type AdapterLogLine = {
  type: 'log';
  timestamp?: string;
  level?: string;
  message?: string;
  correlationId?: string;
  data?: any;
};

export function parseAdapterLogLines(lines: string[]): AdapterLogLine[] {
  const parsed: AdapterLogLine[] = [];
  for (const line of lines) {
    const raw = typeof line === 'string' ? line.trim() : '';
    if (!raw) continue;
    try {
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object') continue;
      if ((obj as any).type !== 'log') continue;
      parsed.push(obj as AdapterLogLine);
    } catch {
      // Ignore invalid JSON log lines.
    }
  }
  return parsed;
}

export function findToolRoutingLogs(
  lines: string[],
  options: { toolName?: string } = {}
): AdapterLogLine[] {
  const target = typeof options.toolName === 'string' ? options.toolName : '';
  return parseAdapterLogLines(lines).filter((entry) => {
    if (entry.message !== 'Routing tool call') return false;
    if (!target) return true;
    return entry.data?.toolName === target;
  });
}

export function getToolRoutingRouteIds(lines: string[], toolName: string): string[] {
  const ids: string[] = [];
  for (const entry of findToolRoutingLogs(lines, { toolName })) {
    const routeId = entry.data?.routeId;
    if (typeof routeId === 'string' && routeId.trim()) {
      ids.push(routeId.trim());
    }
  }
  return ids;
}
