/**
 * Colours of VS Code's default themes (Light Modern and Dark Modern), so a runbook looks the way
 * it does in the editor. The phone's light or dark setting picks one; screens get their styles
 * through `themedStyles`, which builds each style sheet once per palette.
 */
import type { TermColor } from '@md-runbook/core';
import { ImageStyle, Platform, StyleSheet, TextStyle, ViewStyle, useColorScheme } from 'react-native';

export interface Palette {
  dark: boolean;
  background: string;
  text: string;
  muted: string;
  /** Placeholder text in inputs: lighter than real values, so an empty field doesn't look filled. */
  placeholder: string;
  border: string;
  /** Code cells and other code blocks (the notebook's cell editor). */
  codeBackground: string;
  /** Cards on the start screen: a grouped list a step off the page. */
  surface: string;
  /** A tinted button (the accent, softened) beside a filled one. */
  accentSoft: string;
  /** Bottom sheets: raised above the page (in dark, lighter than it, as VS Code's quick pick). */
  sheet: string;
  /** The dimmed screen behind a sheet. */
  scrim: string;
  /** Inline `code` in Markdown. */
  inlineCode: string;
  ok: string;
  error: string;
  warning: string;
  accent: string;
  onAccent: string;
  link: string;
  /** Line numbers and gutter glyphs at rest. */
  gutter: string;
  /** The line whose actions are open. */
  lineHighlight: string;
  quoteBorder: string;
  /** VS Code's terminal colours, for coloured output (log levels, stderr, a program's own colours). */
  terminal: Record<TermColor, string>;
  syntax: {
    comment: string;
    keyword: string;
    control: string;
    string: string;
    variable: string;
    number: string;
    command: string;
    operator: string;
  };
}

export const light: Palette = {
  dark: false,
  background: '#ffffff',
  text: '#3b3b3b',
  muted: '#616161',
  placeholder: '#a0a0a0',
  border: '#e5e5e5',
  codeBackground: '#f8f8f8',
  surface: '#f8f8f8',
  accentSoft: '#e5effa',
  sheet: '#ffffff',
  scrim: 'rgba(0, 0, 0, 0.3)',
  inlineCode: '#ebebeb',
  ok: '#388a34',
  error: '#e51400',
  warning: '#bf8803',
  accent: '#005fb8',
  onAccent: '#ffffff',
  link: '#005fb8',
  gutter: '#6e7681',
  lineHighlight: '#e8f2ff',
  quoteBorder: '#d0d7de',
  terminal: {
    black: '#000000',
    red: '#cd3131',
    green: '#00bc00',
    yellow: '#949800',
    blue: '#0451a5',
    magenta: '#bc05bc',
    cyan: '#0598bc',
    white: '#555555',
    grey: '#666666',
    brightBlue: '#0451a5',
  },
  syntax: {
    comment: '#008000',
    keyword: '#0000ff',
    control: '#af00db',
    string: '#a31515',
    variable: '#001080',
    number: '#098658',
    command: '#795e26',
    operator: '#3b3b3b',
  },
};

export const dark: Palette = {
  dark: true,
  background: '#1f1f1f',
  text: '#cccccc',
  muted: '#9d9d9d',
  placeholder: '#6b6b6b',
  border: '#3c3c3c',
  codeBackground: '#181818',
  surface: '#272727',
  accentSoft: '#1b3a57',
  sheet: '#282828',
  scrim: 'rgba(0, 0, 0, 0.6)',
  inlineCode: '#2b2b2b',
  ok: '#73c991',
  error: '#f14c4c',
  warning: '#cca700',
  accent: '#0078d4',
  onAccent: '#ffffff',
  link: '#4daafc',
  gutter: '#6e7681',
  lineHighlight: '#2a2d2e',
  quoteBorder: '#454545',
  terminal: {
    black: '#000000',
    red: '#f14c4c',
    green: '#23d18b',
    yellow: '#f5f543',
    blue: '#3b8eea',
    magenta: '#d670d6',
    cyan: '#29b8db',
    white: '#e5e5e5',
    grey: '#8a8a8a',
    brightBlue: '#7cb7ff',
  },
  syntax: {
    comment: '#6a9955',
    keyword: '#569cd6',
    control: '#c586c0',
    string: '#ce9178',
    variable: '#9cdcfe',
    number: '#b5cea8',
    command: '#dcdcaa',
    operator: '#d4d4d4',
  },
};

export function usePalette(): Palette {
  return useColorScheme() === 'dark' ? dark : light;
}

/** A hook giving the style sheet built by `make` for the current palette (built once per palette). */
export function themedStyles<T extends { [K in keyof T]: ViewStyle | TextStyle | ImageStyle }>(make: (c: Palette) => T): () => T {
  const built = new Map<Palette, T>();
  return function useThemedStyles(): T {
    const c = usePalette();
    let s = built.get(c);
    if (!s) {
      s = StyleSheet.create(make(c));
      built.set(c, s);
    }
    return s;
  };
}

export const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, Menlo, Consolas, monospace' });
