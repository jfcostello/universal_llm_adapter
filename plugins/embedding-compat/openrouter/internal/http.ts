import axios, { type AxiosInstance } from 'axios';
import { getDefaults } from '../../../../kernel/index.js';

export function createOpenRouterEmbeddingHttpClient(): AxiosInstance {
  return axios.create({
    timeout: getDefaults().timeouts.embeddingHttp,
    validateStatus: () => true
  });
}

