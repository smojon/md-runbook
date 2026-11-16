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

// Local notifications (native): nothing asked yet; asking grants; scheduling returns ids. Tests
// change the answers with jest.mocked(...) and read what was scheduled.
jest.mock('expo-notifications', () => {
  let next = 1;
  return {
    AndroidImportance: { DEFAULT: 5, HIGH: 6 },
    SchedulableTriggerInputTypes: { TIME_INTERVAL: 'timeInterval' },
    DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
    setNotificationHandler: jest.fn(),
    setNotificationChannelAsync: jest.fn(async () => null),
    getPermissionsAsync: jest.fn(async () => ({ status: 'undetermined', granted: false, canAskAgain: true, expires: 'never' })),
    requestPermissionsAsync: jest.fn(async () => ({ status: 'granted', granted: true, canAskAgain: true, expires: 'never' })),
    scheduleNotificationAsync: jest.fn(async () => `n${next++}`),
    cancelScheduledNotificationAsync: jest.fn(async () => undefined),
    dismissNotificationAsync: jest.fn(async () => undefined),
    addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
    // Pushes (notifications/alertPush.ts): a native token, and no new one.
    getDevicePushTokenAsync: jest.fn(async () => ({ type: 'ios', data: 'a'.repeat(64) })),
    addPushTokenListener: jest.fn(() => ({ remove: jest.fn() })),
    getLastNotificationResponse: jest.fn(() => null),
    clearLastNotificationResponse: jest.fn(),
  };
});

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
