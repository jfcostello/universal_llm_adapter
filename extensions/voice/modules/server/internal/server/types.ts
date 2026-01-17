import type http from 'http';
import type net from 'net';

export type VoiceMediaTokenPayload = {
  iat: number;
  exp: number;
  nonce: string;
  purpose: 'voice_media';
  callConfigId: string;
  voiceProvider: string;
};

export type VoiceLogger = {
  withCorrelation: (correlationId: string | string[]) => VoiceLogger;
  debug: (message: string, data?: any) => void;
  info: (message: string, data?: any) => void;
  warning: (message: string, data?: any) => void;
  error: (message: string, data?: any) => void;
};

export type VoiceLogging = {
  getLogger: (correlationId?: string) => VoiceLogger;
};

export type VoiceServerRegistration = {
  handleHttp: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;
  handleUpgrade: (ctx: { req: http.IncomingMessage; socket: net.Socket; head: Buffer; pathname: string }) => Promise<boolean>;
  close: () => Promise<void>;
};

