/**
 * Outbound HTTP client defaults.
 */
export interface OutboundHttpDefaults {
  /**
   * Whether outbound HTTP keep-alive is enabled (opt-in; default false).
   */
  keepAliveEnabled: boolean;
  /**
   * Maximum number of concurrent sockets per agent.
   */
  maxSockets: number;
  /**
   * Maximum number of idle keep-alive sockets to retain.
   */
  maxFreeSockets: number;
}

