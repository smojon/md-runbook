/**
 * Requests that carry a token (an upload token, a devices token) never follow a redirect: the
 * token would go along to wherever it points.
 *
 * - iOS and Android: Expo SDK 58 installs expo/fetch as the global `fetch`. It honours
 *   `redirect: 'error'` natively: URLSession's redirect delegate gets no new request, OkHttp runs
 *   with followRedirects(false). Browsers honour it too.
 * - Only a build with EXPO_PUBLIC_USE_RN_FETCH would get React Native's own fetch, which follows
 *   redirects whatever the option. No config of ours sets it (a test checks).
 *
 * redirectedTo is the second line: an answer that shows a redirect (3xx, `redirected`, another
 * final address) is refused, and the request is never sent again. On a runtime that followed the
 * redirect, the token has gone out by then: that is the risk left.
 */

export const NO_REDIRECT = { redirect: 'error' } as const;

const hrefOf = (url: string): string | undefined => {
  try {
    return new URL(url).href;
  } catch {
    return undefined;
  }
};

/** The host an answer came from when it isn't the address asked (a redirect), else undefined. */
export function redirectedTo(asked: string, answer: { status: number; url?: string | null; redirected?: boolean }): string | undefined {
  const final = answer.url ? hrefOf(answer.url) : undefined;
  const moved =
    (final !== undefined && final !== hrefOf(asked)) || answer.redirected === true || (answer.status >= 300 && answer.status < 400);
  if (!moved) return undefined;
  try {
    return new URL(final ?? asked).host;
  } catch {
    return '?';
  }
}
