export async function normalizeToolCallsIfPresent(toolCalls: any): Promise<any> {
  if (!toolCalls || !Array.isArray(toolCalls) || toolCalls.length === 0) {
    return toolCalls;
  }

  const { normalizeToolCalls } = await import('../../../../tools/index.js');
  return normalizeToolCalls(toolCalls);
}
