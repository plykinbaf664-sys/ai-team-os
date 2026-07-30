import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTickTickAuthorizationUrl,
  exchangeTickTickAuthorizationCode,
} from "../lib/integrations/ticktick/ticktick-oauth";

const CONFIG = {
  clientId: "client-id",
  clientSecret: "client-secret",
  redirectUri:
    "http://localhost:3000/api/integrations/ticktick/oauth/callback",
};

test("builds a state-protected TickTick authorization URL", () => {
  const url = new URL(
    buildTickTickAuthorizationUrl(CONFIG, "secure-state"),
  );

  assert.equal(url.origin, "https://ticktick.com");
  assert.equal(url.pathname, "/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "client-id");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(
    url.searchParams.get("scope"),
    "tasks:read tasks:write",
  );
  assert.equal(url.searchParams.get("state"), "secure-state");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    CONFIG.redirectUri,
  );
});

test("exchanges an authorization code using server-side Basic auth", async () => {
  let authorization: string | null = null;
  const bodies: URLSearchParams[] = [];

  const token = await exchangeTickTickAuthorizationCode({
    code: "authorization-code",
    config: CONFIG,
    fetchImplementation: (async (_input, init) => {
      authorization = new Headers(init?.headers).get("Authorization");
      bodies.push(init?.body as URLSearchParams);

      return Response.json({
        access_token: "access-token",
      });
    }) as typeof fetch,
  });

  assert.equal(
    authorization,
    `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
  );
  assert.equal(bodies[0].get("code"), "authorization-code");
  assert.equal(bodies[0].get("grant_type"), "authorization_code");
  assert.equal(bodies[0].get("scope"), "tasks:read tasks:write");
  assert.equal(bodies[0].get("redirect_uri"), CONFIG.redirectUri);
  assert.equal(token, "access-token");
});

test("rejects failed or incomplete token responses", async () => {
  await assert.rejects(
    exchangeTickTickAuthorizationCode({
      code: "bad-code",
      config: CONFIG,
      fetchImplementation: (async () =>
        Response.json(
          { error: "invalid_grant" },
          { status: 400 },
        )) as typeof fetch,
    }),
    /invalid_grant/,
  );

  await assert.rejects(
    exchangeTickTickAuthorizationCode({
      code: "code",
      config: CONFIG,
      fetchImplementation: (async () =>
        Response.json({})) as typeof fetch,
    }),
    /access_token/,
  );
});
