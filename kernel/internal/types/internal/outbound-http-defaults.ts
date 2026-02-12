/**
 * Outbound HTTP client defaults.
 */
export interface OutboundHttpDefaults {
  /**
   * Whether outbound HTTP keep-alive is enabled (default true).
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
