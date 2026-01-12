import type http from 'http';

export default {
  name: 'voice',
  registerServer: async (_ctx: {
    server: http.Server;
    registry: any;
    pluginsPath: string;
    upgradeRouter: any;
    httpConfig?: any;
  }) => {
    const { createVoiceServerRegistration } = await import('./modules/server/index.js');
    const reg = await createVoiceServerRegistration(_ctx as any);
    return {
      handleHttp: reg.handleHttp,
      handleUpgrade: reg.handleUpgrade,
      close: reg.close
    };
  },
  runCli: async (ctx: { argv: string[]; deps: any }) => {
    const { runVoiceCli } = await import('./modules/cli/index.js');
    await runVoiceCli(ctx);
  }
};
