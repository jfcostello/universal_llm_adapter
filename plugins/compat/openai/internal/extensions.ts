export function applyProviderExtensions(payload: any, extensions: any): any {
  if (extensions.provider) {
    payload.provider = extensions.provider;
    delete extensions.provider;
  }

  if (extensions.plugins !== undefined) {
    payload.plugins = extensions.plugins;
    delete extensions.plugins;
  }

  const openRouterFields = ['transforms', 'route', 'models'];
  for (const field of openRouterFields) {
    if (extensions[field] !== undefined) {
      payload[field] = extensions[field];
      delete extensions[field];
    }
  }

  return payload;
}

