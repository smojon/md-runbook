import { forgetSecret, loadSecretNames, readSecret, resetSecretNames, storeSecret, useSecretNames } from '../secrets/store';
import { renderHook } from '@testing-library/react-native';

describe('stored secrets', () => {
  beforeEach(() => resetSecretNames());

  it('keeps values in the secure store and names in a list, and forgets both', async () => {
    await storeSecret('API_TOKEN', 'abc123');
    await storeSecret('DB_PASSWORD', 'pw');
    expect(await readSecret('API_TOKEN')).toBe('abc123');
    const { result } = await renderHook(() => useSecretNames());
    expect(result.current).toEqual(['API_TOKEN', 'DB_PASSWORD']);
    await forgetSecret('API_TOKEN');
    expect(await readSecret('API_TOKEN')).toBeUndefined();
    // The list survives a restart (kv), without the forgotten name.
    resetSecretNames();
    await loadSecretNames();
    const again = await renderHook(() => useSecretNames());
    expect(again.result.current).toEqual(['DB_PASSWORD']);
  });

  it('refuses names that are not variable names', async () => {
    await expect(storeSecret('not-a-name', 'x')).rejects.toThrow(/not a secret name/);
    expect(await readSecret('../x')).toBeUndefined();
  });
});
