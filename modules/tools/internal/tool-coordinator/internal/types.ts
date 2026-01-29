import type { AdapterLogger } from '../../../../../kernel/index.js';

export interface ToolContext {
  toolName: string;
  callId: string;
  args: any;
  provider: string;
  model: string;
  metadata?: any;
  callProgress?: any;
}

export interface ToolRouteAndInvokeContext {
  provider: string;
  model: string;
  metadata?: any;
  toolId?: string;
  processRouteId?: string;
  logger?: AdapterLogger;
  callProgress?: any;
}
