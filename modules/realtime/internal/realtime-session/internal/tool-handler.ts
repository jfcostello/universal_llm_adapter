import type {
  JsonValue,
  ProcessRouteManifest,
  UnifiedTool,
  RealtimeCompatSession,
  RealtimeEvent,
  RealtimeSessionSpec
} from '../../../../../kernel/index.js';

type ToolCoordinatorLike = {
  routeAndInvoke: (
    toolName: string,
    callId: string,
    args: any,
    context: { provider: string; model: string; metadata?: any; logger?: any; callProgress?: any; toolId?: string; processRouteId?: string }
  ) => Promise<any>;
};

export class RealtimeToolHandler {
  private enabledToolNames: Set<string> | undefined;
  private toolCoordinatorPromise: Promise<ToolCoordinatorLike> | undefined;
  private toolByName = new Map<string, UnifiedTool>();

  constructor(private options: {
    registry: { getProcessRoutes: () => Promise<ProcessRouteManifest[]> };
    spec: RealtimeSessionSpec;
    tools?: UnifiedTool[];
    compatSession: RealtimeCompatSession;
    pushEvent: (event: RealtimeEvent) => void;
    closeOnError: () => Promise<void>;
    recordToolCall?: (call: { id: string; name: string; arguments?: any }) => void;
  }) {
    if (options.spec.functionToolNames && options.spec.functionToolNames.length > 0) {
      this.enabledToolNames = new Set(options.spec.functionToolNames);
    }
    if (Array.isArray(options.tools)) {
      for (const tool of options.tools) {
        if (tool && typeof tool.name === 'string') {
          this.toolByName.set(tool.name, tool);
        }
      }
    }
  }

  async handleToolCallEnd(event: Extract<RealtimeEvent, { type: 'tool_call.end' }>): Promise<void> {
    if (!this.enabledToolNames) {
      this.options.pushEvent({ type: 'error', message: 'Tool call received but tools are not enabled', code: 'tools_disabled' });
      await this.options.closeOnError();
      return;
    }

    if (!this.enabledToolNames.has(event.name)) {
      this.options.pushEvent({ type: 'error', message: `Tool not enabled: ${event.name}`, code: 'tool_not_enabled' });
      await this.options.closeOnError();
      return;
    }

    this.options.recordToolCall?.({
      id: event.toolCallId,
      name: event.name,
      arguments: event.arguments
    });

    const coordinator = await this.ensureToolCoordinator();
    try {
      const toolDef = this.toolByName.get(event.name);
      const toolId = typeof toolDef?.id === 'string' ? String(toolDef.id).trim() || undefined : undefined;
      const toolProcessRouteId =
        typeof toolDef?.processRouteId === 'string' ? String(toolDef.processRouteId).trim() || undefined : undefined;

      const toolRouting = this.options.spec.toolRouting;
      const routeFromName = toolRouting?.routesByName?.[event.name];
      const routeFromId = toolId ? toolRouting?.routesById?.[toolId] : undefined;
      const processRouteId = typeof routeFromName === 'string' && routeFromName.trim()
        ? routeFromName.trim()
        : typeof routeFromId === 'string' && routeFromId.trim()
          ? routeFromId.trim()
          : toolProcessRouteId;

      const result = await coordinator.routeAndInvoke(
        event.name,
        event.toolCallId,
        event.arguments,
        {
          provider: this.options.spec.provider,
          model: this.options.spec.model ?? this.options.spec.provider,
          metadata: this.options.spec.metadata ?? {},
          toolId,
          processRouteId
        }
      );
      await this.options.compatSession.sendToolResult({
        toolCallId: event.toolCallId,
        result: result as JsonValue
      });
      this.options.pushEvent({ type: 'tool_result.sent', toolCallId: event.toolCallId });
    } catch (error: any) {
      this.options.pushEvent({ type: 'error', message: `Tool execution failed: ${error?.message ?? String(error)}`, code: 'tool_error' });
      await this.options.closeOnError();
    }
  }

  private async ensureToolCoordinator(): Promise<ToolCoordinatorLike> {
    if (!this.toolCoordinatorPromise) {
      this.toolCoordinatorPromise = (async () => {
        const routes = await this.options.registry.getProcessRoutes();
        const { ToolCoordinator } = await import('../../../../tools/index.js');
        return new ToolCoordinator(routes as any, undefined, { registry: this.options.registry as any }) as unknown as ToolCoordinatorLike;
      })();
    }
    return await this.toolCoordinatorPromise;
  }
}
