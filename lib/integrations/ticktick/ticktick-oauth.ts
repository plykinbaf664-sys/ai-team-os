import { Buffer } from "node:buffer";

const AUTHORIZE_URL = "https://ticktick.com/oauth/authorize";
const TOKEN_URL = "https://ticktick.com/oauth/token";
const SCOPES = "tasks:read tasks:write";

type FetchImplementation = typeof fetch;

export type TickTickOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

type TickTickTokenResponse = {
  access_token?: string;
  error?: string;
  error_description?: string;
};

export function getTickTickOAuthConfig(): TickTickOAuthConfig {
  const clientId = process.env.TICKTICK_CLIENT_ID?.trim();
  const clientSecret = process.env.TICKTICK_CLIENT_SECRET?.trim();
  const redirectUri = process.env.TICKTICK_REDIRECT_URI?.trim();

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "TICKTICK_CLIENT_ID, TICKTICK_CLIENT_SECRET and TICKTICK_REDIRECT_URI are required.",
    );
  }

  return { clientId, clientSecret, redirectUri };
}

export function buildTickTickAuthorizationUrl(
  config: Pick<TickTickOAuthConfig, "clientId" | "redirectUri">,
  state: string,
) {
  const parameters = new URLSearchParams({
    client_id: config.clientId,
    scope: SCOPES,
    state,
    redirect_uri: config.redirectUri,
    response_type: "code",
  });

  return `${AUTHORIZE_URL}?${parameters.toString()}`;
}

export async function exchangeTickTickAuthorizationCode({
  code,
  config,
  fetchImplementation = fetch,
}: {
  code: string;
  config: TickTickOAuthConfig;
  fetchImplementation?: FetchImplementation;
}) {
  if (!code.trim()) {
    throw new Error("TickTick authorization code is required.");
  }

  const body = new URLSearchParams({
    code,
    grant_type: "authorization_code",
    scope: SCOPES,
    redirect_uri: config.redirectUri,
  });
  const basicCredentials = Buffer.from(
    `${config.clientId}:${config.clientSecret}`,
  ).toString("base64");
  const response = await fetchImplementation(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicCredentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const data = (await response.json()) as TickTickTokenResponse;

  if (!response.ok) {
    throw new Error(
      data.error_description ||
        data.error ||
        `TickTick token exchange failed with status ${response.status}.`,
    );
  }

  const accessToken = data.access_token?.trim();

  if (!accessToken) {
    throw new Error("TickTick token response did not contain access_token.");
  }

  return accessToken;
}
