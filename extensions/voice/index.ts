import type http from 'http';

import { createVoiceServerRegistration } from './internal/server.js';

export default {
  name: 'voice',
  registerServer: async (_ctx: {
    server: http.Server;
    registry: any;
    pluginsPath: string;
    upgradeRouter: any;
  }) => {
    const reg = await createVoiceServerRegistration(_ctx as any);
    return {
      handleHttp: reg.handleHttp,
      handleUpgrade: reg.handleUpgrade,
      close: reg.close
    };
  }
};
