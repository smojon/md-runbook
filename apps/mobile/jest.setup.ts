// Native modules the tests never reach a device for: storage keeps values in memory for one test
// file, the TCP socket is absent (the SSH layer is tested with a fake connection and, in CI,
// against a real server through the Node transport), and Web Crypto is Node's (the app has it
// from react-native-quick-crypto and the browser).
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

const mockSecrets = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afterFirstUnlockThisDeviceOnly',
  getItemAsync: async (k: string) => mockSecrets.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => void mockSecrets.set(k, v),
  deleteItemAsync: async (k: string) => void mockSecrets.delete(k),
}));

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

jest.mock('react-native-tcp-socket', () => ({
  __esModule: true,
  default: {
    createConnection: () => {
      throw new Error('no TCP sockets in Jest');
    },
  },
}));

const g = globalThis as { crypto?: unknown };
g.crypto ??= jest.requireActual<{ webcrypto: unknown }>('node:crypto').webcrypto;
