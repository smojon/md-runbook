import { act, render, screen } from '@testing-library/react-native';
import { STDERR_MARK } from '@md-runbook/core';
import { useState } from 'react';
import { Text } from 'react-native';
import { OutputText } from '../cells/OutputText';
import { resetSettings, setOutputSetting, useOutputSettings } from '../settings/store';
import { light } from '../theme';

// The real settings hook, counted: OutputText calls it once per render.
jest.mock('../settings/store', () => {
  const actual = jest.requireActual('../settings/store');
  return { ...actual, useOutputSettings: jest.fn(actual.useOutputSettings) };
});

interface Node {
  type: string;
  props: { style?: { color?: string } };
  children: (Node | string)[] | null;
}

/** The coloured runs of the output: [text, colour] for each Text with a colour and only text in it. */
const coloured = (): [string, string][] => {
  const out: [string, string][] = [];
  const walk = (n: Node | string | null): void => {
    if (!n || typeof n === 'string') return;
    const color = n.props.style?.color;
    if (n.type === 'Text' && color && n.children?.every((c) => typeof c === 'string')) out.push([n.children.join(''), color]);
    else n.children?.forEach(walk);
  };
  walk(screen.toJSON() as unknown as Node);
  return out;
};

describe('coloured output', () => {
  beforeEach(() => resetSettings());

  it('log levels in their colours, stderr lines in red (marked live, or listed in stderr=)', async () => {
    await render(<OutputText style={{}} text={`INFO up\n${STDERR_MARK}boom\nplain OK`} />);
    expect(coloured()).toEqual([
      ['INFO', light.terminal.blue],
      ['boom', light.terminal.red],
      ['OK', light.terminal.green],
    ]);
    await render(<OutputText style={{}} text={'one\ntwo'} stderr="2" />);
    expect(coloured()).toEqual([['two', light.terminal.red]]);
  });

  it("a program's own ANSI colours, and the settings turn the others off", async () => {
    await render(<OutputText style={{}} text={'\u001b[32mgreen\u001b[0m ERROR'} />);
    expect(coloured()).toEqual([['green', light.terminal.green]]);
    setOutputSetting('colorLevels', false);
    setOutputSetting('stderrInRed', false);
    await render(<OutputText style={{}} text={`ERROR\n${STDERR_MARK}boom`} stderr="1" />);
    expect(coloured()).toEqual([]);
    expect(screen.getByText('ERROR\nboom')).toBeTruthy();
  });
});

describe('a running cell ticking every second', () => {
  it("doesn't render its unchanged output again", async () => {
    const style = {};
    let tick: () => void = () => undefined;
    function Cell() {
      const [now, setNow] = useState(0);
      tick = () => setNow((n) => n + 1);
      return (
        <>
          <Text>{`running · ${now}s`}</Text>
          <OutputText style={style} text={'INFO one\ntwo'} />
        </>
      );
    }
    await render(<Cell />);
    const renders = jest.mocked(useOutputSettings).mock.calls.length;
    await act(async () => tick());
    expect(screen.getByText('running · 1s')).toBeTruthy();
    expect(jest.mocked(useOutputSettings).mock.calls.length).toBe(renders);
  });
});
