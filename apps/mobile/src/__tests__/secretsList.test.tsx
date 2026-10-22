import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { HostList } from '../screens/HostList';
import { readSecret, resetSecretNames, storeSecret } from '../secrets/store';

jest.mock('expo-router', () => ({ Link: ({ children }: { children: unknown }) => children }));
jest.mock('../ssh/appKey', () => ({
  appPublicKeyLine: async () => 'ecdsa-sha2-nistp256 AAAA md-runbook',
  appKeyInfo: async () => ({ storage: 'secure-store' }),
}));

beforeEach(() => resetSecretNames());

describe('Hosts → Secrets', () => {
  it('lists stored names (never values); Change sets a new value, Forget removes it', async () => {
    await storeSecret('API_TOKEN', 'old-value');
    await storeSecret('DB_PASSWORD', 'pw-1234');
    await render(<HostList />);
    await waitFor(() => expect(screen.getByText('API_TOKEN')).toBeTruthy());
    expect(screen.queryByText('old-value')).toBeNull();

    await act(async () => {
      fireEvent.press(screen.getByTestId('change-secret-API_TOKEN'));
    });
    expect(screen.getByTestId('secret-value-API_TOKEN').props.secureTextEntry).toBe(true);
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('secret-value-API_TOKEN'), 'new-value');
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('save-secret-API_TOKEN'));
    });
    expect(await readSecret('API_TOKEN')).toBe('new-value');
    expect(screen.queryByTestId('secret-value-API_TOKEN')).toBeNull();

    await act(async () => {
      fireEvent.press(screen.getByTestId('forget-secret-DB_PASSWORD'));
    });
    await waitFor(() => expect(screen.queryByText('DB_PASSWORD')).toBeNull());
    expect(await readSecret('DB_PASSWORD')).toBeUndefined();
  });
});
