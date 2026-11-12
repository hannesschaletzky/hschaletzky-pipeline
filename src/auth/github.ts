/**
 * GitHub as identity provider: we only need to know *who* logged in (the numeric user id).
 * No scopes are requested, so the GitHub token cannot read anything beyond the public profile,
 * and it is discarded right after the lookup.
 */
export interface IdentityProvider {
  /** Where to send the browser to log in. */
  authorizeUrl(state: string, callbackUrl: string): string;
  /** Exchanges the code from the login callback for the user's numeric id. */
  userIdForCode(code: string, callbackUrl: string): Promise<number>;
}

export function githubIdentity({
  clientId,
  clientSecret,
}: {
  clientId: string;
  clientSecret: string;
}): IdentityProvider {
  return {
    authorizeUrl(state, callbackUrl) {
      const url = new URL('https://github.com/login/oauth/authorize');
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: callbackUrl,
        state,
        allow_signup: 'false',
      }).toString();
      return url.toString();
    },

    async userIdForCode(code, callbackUrl) {
      const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: callbackUrl,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const token = (await tokenResponse.json()) as { access_token?: string; error?: string };
      if (!tokenResponse.ok || !token.access_token) {
        throw new Error(
          `GitHub token exchange failed: ${token.error ?? String(tokenResponse.status)}`,
        );
      }

      const userResponse = await fetch('https://api.github.com/user', {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token.access_token}`,
          'User-Agent': 'hschaletzky-pipeline',
        },
        signal: AbortSignal.timeout(10_000),
      });
      const user = (await userResponse.json()) as { id?: unknown };
      if (!userResponse.ok || typeof user.id !== 'number') {
        throw new Error(`GitHub user lookup failed: ${String(userResponse.status)}`);
      }
      return user.id;
    },
  };
}
