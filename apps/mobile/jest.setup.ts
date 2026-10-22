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

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true), getStringAsync: jest.fn(async () => '') }));
// Reports and sharing (native: a PDF renderer and the share sheet).
jest.mock('expo-print', () => ({ printToFileAsync: jest.fn(async () => ({ uri: 'file:///cache/print.pdf' })) }));
jest.mock('expo-sharing', () => ({ shareAsync: jest.fn(async () => undefined), isAvailableAsync: jest.fn(async () => true) }));

// The app's copies of runbooks (the documents folder does not exist in Jest): in memory.
const mockDocs = new Map<string, string>();
jest.mock('./src/storage/docs', () => ({
  readDoc: async (id: string) => mockDocs.get(id),
  writeDoc: async (id: string, text: string) => void mockDocs.set(id, text),
  deleteDoc: async (id: string) => void mockDocs.delete(id),
}));

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
