type FetchImplementation = typeof fetch;

type GoogleOAuthTokenResponse = {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
};

export type GoogleAccessTokenProvider = () => Promise<string>;

export function createGoogleAccessTokenProvider({
  clientId = process.env.GOOGLE_CLIENT_ID,
  clientSecret = process.env.GOOGLE_CLIENT_SECRET,
  refreshToken = process.env.GOOGLE_REFRESH_TOKEN,
  fetchImplementation = fetch,
  now = Date.now,
}: {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  fetchImplementation?: FetchImplementation;
  now?: () => number;
} = {}): GoogleAccessTokenProvider | null {
  if (!clientId || !clientSecret || !refreshToken) {
    return null;
  }

  let cachedToken: { value: string; expiresAt: number } | null = null;

  return async () => {
    const currentTime = now();

    if (cachedToken && cachedToken.expiresAt > currentTime + 60_000) {
      return cachedToken.value;
    }

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });
    const response = await fetchImplementation(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      },
    );
    const data = (await response.json()) as GoogleOAuthTokenResponse;

    if (!response.ok || !data.access_token) {
      throw new Error(
        data.error_description ||
          data.error ||
          `Google OAuth refresh failed with status ${response.status}.`,
      );
    }

    cachedToken = {
      value: data.access_token,
      expiresAt: currentTime + (data.expires_in ?? 3_600) * 1_000,
    };

    return cachedToken.value;
  };
}
