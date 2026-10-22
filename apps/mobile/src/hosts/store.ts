/**
 * The hosts the app can run cells on: name, address, user and, once the user trusted it, the
 * server's host key. Kept in storage/kv (no secrets here: the app's key is in storage/secure) and
 * loaded once at start; screens read it with useHosts().
 */
import { useSyncExternalStore } from 'react';
import { getJson, setJson } from '../storage/kv';

export interface Host {
  id: string;
  name: string;
  hostname: string;
  port: number;
  username: string;
  /** `type base64` of the host key the user trusted (see hostKeyId); absent until the first run. */
  hostKey?: string;
  /** What the server runs, learnt on the first connection: sh/bash (Linux, macOS) or Windows PowerShell. */
  platform?: 'posix' | 'windows';
}

export type HostInput = Omit<Host, 'id' | 'hostKey' | 'platform'>;

export interface HostMessages {
  nameMissing: string;
  hostnameMissing: string;
  portInvalid: string;
  usernameMissing: string;
}

const KEY = 'hosts.v1';
let hosts: readonly Host[] = [];
let loaded: Promise<void> | undefined;
const listeners = new Set<() => void>();

const isHost = (v: unknown): v is Host => {
  if (typeof v !== 'object' || v === null) return false;
  const h = v as Record<string, unknown>;
  return (
    typeof h.id === 'string' &&
    typeof h.name === 'string' &&
    typeof h.hostname === 'string' &&
    typeof h.port === 'number' &&
    typeof h.username === 'string' &&
    (h.hostKey === undefined || typeof h.hostKey === 'string') &&
    (h.platform === undefined || h.platform === 'posix' || h.platform === 'windows')
  );
};
const isHostList = (v: unknown): v is Host[] => Array.isArray(v) && v.every(isHost);

/** Read the saved hosts once (later calls return the same promise). */
export function loadHosts(): Promise<void> {
  loaded ??= getJson(KEY, isHostList).then((saved) => {
    if (saved) publish(saved, false);
  });
  return loaded;
}

function publish(next: readonly Host[], save = true): void {
  hosts = next;
  listeners.forEach((l) => l());
  if (save) void setJson(KEY, next).catch(() => undefined);
}

/** Problems with a host as typed, one line each; empty when it can be saved. */
export function validateHost(input: HostInput, messages: HostMessages): string[] {
  const errors: string[] = [];
  if (input.name.trim() === '') errors.push(messages.nameMissing);
  if (input.hostname.trim() === '' || /\s/.test(input.hostname.trim())) errors.push(messages.hostnameMissing);
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) errors.push(messages.portInvalid);
  if (input.username.trim() === '' || /\s/.test(input.username.trim())) errors.push(messages.usernameMissing);
  return errors;
}

const clean = (input: HostInput): HostInput => ({
  name: input.name.trim(),
  hostname: input.hostname.trim(),
  port: input.port,
  username: input.username.trim(),
});

export function addHost(input: HostInput): Host {
  const h: Host = { id: `h${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`, ...clean(input) };
  publish([...hosts, h]);
  return h;
}

/** Address changes drop the trusted host key: another machine may answer there. */
export function updateHost(id: string, input: HostInput): Host | undefined {
  const old = hosts.find((h) => h.id === id);
  if (!old) return undefined;
  const next = clean(input);
  const sameServer = next.hostname === old.hostname && next.port === old.port;
  // Another address may be another server: its key and what it runs are learnt again.
  const h: Host = {
    id,
    ...next,
    ...(sameServer && old.hostKey ? { hostKey: old.hostKey } : {}),
    ...(sameServer && old.platform ? { platform: old.platform } : {}),
  };
  publish(hosts.map((x) => (x.id === id ? h : x)));
  return h;
}

export function removeHost(id: string): void {
  publish(hosts.filter((h) => h.id !== id));
}

/** Remember (or forget, with undefined) the server's host key after the user trusted it. */
export function pinHostKey(id: string, hostKey: string | undefined): void {
  publish(hosts.map((h) => (h.id === id ? { ...h, hostKey } : h)));
}

export function setHostPlatform(id: string, platform: 'posix' | 'windows'): void {
  if (hosts.some((h) => h.id === id && h.platform !== platform)) publish(hosts.map((h) => (h.id === id ? { ...h, platform } : h)));
}

export function getHost(id: string | undefined): Host | undefined {
  return hosts.find((h) => h.id === id);
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useHosts(): readonly Host[] {
  return useSyncExternalStore(subscribe, () => hosts);
}

/** `user@host` or `user@host:port` when the port is not 22. */
export function hostLabel(h: Host): string {
  return `${h.username}@${h.hostname}${h.port === 22 ? '' : `:${h.port}`}`;
}

/** Tests only. */
export function resetHosts(): void {
  hosts = [];
  loaded = undefined;
  listeners.forEach((l) => l());
}
