import { jest } from '@jest/globals';

export interface WinstonMockHarness {
  module: typeof import('@/core/logging.ts');
  mocks: {
    logger: {
      debug: jest.Mock;
      info: jest.Mock;
      warn: jest.Mock;
      error: jest.Mock;
      close: jest.Mock;
    };
    createLogger: jest.Mock;
    consoleTransport: jest.Mock;
    fileTransport: jest.Mock;
    dailyRotate: jest.Mock;
    combine: jest.Mock;
    json: jest.Mock;
    timestamp: jest.Mock;
    printf: jest.Mock;
    getLastConfig: () => Record<string, unknown> | undefined;
    getPrintfFormatter: () => ((info: Record<string, unknown>) => string) | undefined;
    getAllPrintfFormatters: () => Array<(info: Record<string, unknown>) => string>;
  };
}

export interface WinstonMockOptions {
  disableFileLogs?: boolean;
}

export async function setupLoggingTestHarness(
  options: WinstonMockOptions = {}
): Promise<WinstonMockHarness> {
  const unstableMockModule = (jest as unknown as { unstable_mockModule?: typeof jest.unstable_mockModule })
    .unstable_mockModule;

  if (!unstableMockModule) {
    throw new Error('jest.unstable_mockModule is not available in this environment');
  }

  jest.resetModules();

  const loggerStub = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    close: jest.fn(),
    transports: [] as any[]
  };

  let lastCreateLoggerConfig: Record<string, unknown> | undefined;
  const createLoggerMock = jest.fn((config: Record<string, unknown>) => {
    lastCreateLoggerConfig = config;
    return loggerStub;
  });

  const consoleTransportMock = jest.fn().mockImplementation((options: Record<string, unknown>) => ({
    kind: 'console',
    options
  }));

  const fileTransportMock = jest.fn().mockImplementation((options: Record<string, unknown>) => ({
    kind: 'file',
    options
  }));

  const dailyRotateMock = jest.fn().mockImplementation((options: Record<string, unknown>) => ({
    kind: 'dailyRotate',
    options
  }));

  const combineMock = jest.fn((...args: unknown[]) => ({
    kind: 'combine',
    args
  }));

  const jsonMock = jest.fn(() => ({ kind: 'json' }));

  const timestampMock = jest.fn(() => 'timestampMock');

  let printfFormatter: ((info: Record<string, unknown>) => string) | undefined;
  const allPrintfFormatters: Array<(info: Record<string, unknown>) => string> = [];
  const printfMock = jest.fn((formatter: (info: Record<string, unknown>) => string) => {
    printfFormatter = formatter;
    allPrintfFormatters.push(formatter);
    return { kind: 'printf', formatter };
  });

  await unstableMockModule('winston-daily-rotate-file', () => ({
    __esModule: true,
    default: dailyRotateMock
  }));

  await unstableMockModule('winston', () => ({
    __esModule: true,
    default: {},
    transports: { Console: consoleTransportMock, File: fileTransportMock },
    format: {
      combine: combineMock,
      json: jsonMock,
      timestamp: timestampMock,
      printf: printfMock
    },
    createLogger: createLoggerMock
  }));

  process.env.LLM_ADAPTER_DISABLE_FILE_LOGS = options.disableFileLogs ? '1' : '0';

  const module = await import('@/core/logging.ts');

  return {
    module,
    mocks: {
      logger: loggerStub,
      createLogger: createLoggerMock,
      consoleTransport: consoleTransportMock,
      fileTransport: fileTransportMock,
      dailyRotate: dailyRotateMock,
      combine: combineMock,
      json: jsonMock,
      timestamp: timestampMock,
      printf: printfMock,
      getLastConfig: () => lastCreateLoggerConfig,
      getPrintfFormatter: () => printfFormatter,
      getAllPrintfFormatters: () => allPrintfFormatters
    }
  };
}
