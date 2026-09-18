/** Entra token acquisition for the public STANDARD Whisper endpoint. No SDK dependency. */
export function createWhisperIdentity({ env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  let cached;
  let pending;
  return async function headersFor(target) {
    if (!env.WHISPER_AUTH_RESOURCE) {
      if (env.DEPLOYMENT_PROFILE === 'STANDARD') throw new Error('Whisper identity configuration missing');
      return {};
    }
    const service = new URL(env.WHISPER_SERVICE_URL);
    const url = new URL(target);
    if (service.protocol !== 'https:' || url.origin !== service.origin || url.username || url.password) {
      throw new Error('Whisper identity target rejected');
    }
    if (!env.IDENTITY_ENDPOINT || !env.IDENTITY_HEADER || !env.WHISPER_AUTH_CLIENT_ID) {
      throw new Error('Whisper managed identity unavailable');
    }
    if (!cached || cached.expiresAt - now() < 60000) {
      pending ??= (async () => {
        const endpoint = new URL(env.IDENTITY_ENDPOINT);
        endpoint.searchParams.set('api-version', '2019-08-01');
        endpoint.searchParams.set('resource', env.WHISPER_AUTH_RESOURCE);
        endpoint.searchParams.set('client_id', env.WHISPER_AUTH_CLIENT_ID);
        const response = await fetchImpl(endpoint, {
          headers: { 'X-IDENTITY-HEADER': env.IDENTITY_HEADER },
          signal: AbortSignal.timeout(5000), redirect: 'error',
        });
        if (!response.ok) throw new Error('Whisper identity token request failed');
        const token = await response.json();
        const expiresAt = Number(token.expires_on) * 1000;
        if (typeof token.access_token !== 'string' || !token.access_token || !Number.isFinite(expiresAt) || expiresAt - now() < 60000) {
          throw new Error('Whisper identity token invalid or expired');
        }
        cached = { token: token.access_token, expiresAt };
      })().catch(() => { throw new Error('Whisper identity token unavailable'); }).finally(() => { pending = undefined; });
      await pending;
    }
    return { Authorization: `Bearer ${cached.token}` };
  };
}

export const whisperIdentityHeaders = createWhisperIdentity();
