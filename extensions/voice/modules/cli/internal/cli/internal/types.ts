export type VoiceCliDeps = {
  error: (message: string) => void;
  exit: (code: number) => void;
};

export type VoiceCliIo = {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
};

export type VoiceCliCommandContext = {
  deps: VoiceCliDeps;
  io: VoiceCliIo;
};

