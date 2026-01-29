import type { ToolRoutingSpec, UnifiedTool } from '../../../kernel/index.js';

export function resolveToolRoutingHints(options: {
  toolName: string;
  toolDef?: Pick<UnifiedTool, 'id' | 'processRouteId'>;
  toolRouting?: ToolRoutingSpec;
}): { toolId: string | undefined; processRouteId: string | undefined } {
  const toolId = typeof options.toolDef?.id === 'string' ? options.toolDef.id.trim() || undefined : undefined;
  const toolProcessRouteId = typeof options.toolDef?.processRouteId === 'string'
    ? options.toolDef.processRouteId.trim() || undefined
    : undefined;

  const toolName = typeof options.toolName === 'string' ? options.toolName : '';

  const routeFromName = options.toolRouting?.routesByName?.[toolName];
  const normalizedRouteFromName = typeof routeFromName === 'string' ? routeFromName.trim() || undefined : undefined;

  const routeFromId = toolId ? options.toolRouting?.routesById?.[toolId] : undefined;
  const normalizedRouteFromId = typeof routeFromId === 'string' ? routeFromId.trim() || undefined : undefined;

  const processRouteId = normalizedRouteFromName ?? normalizedRouteFromId ?? toolProcessRouteId;

  return { toolId, processRouteId };
}

