import { randomBytes } from "node:crypto";
import {
  buildTickTickAuthorizationUrl,
  getTickTickOAuthConfig,
} from "@/lib/integrations/ticktick/ticktick-oauth";

const STATE_COOKIE = "ticktick_oauth_state";

export async function GET() {
  try {
    const config = getTickTickOAuthConfig();
    const state = randomBytes(32).toString("hex");
    const authorizationUrl = buildTickTickAuthorizationUrl(
      config,
      state,
    );

    return new Response(null, {
      status: 302,
      headers: {
        Location: authorizationUrl,
        "Cache-Control": "no-store",
        "Set-Cookie": serializeStateCookie(state),
      },
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "TickTick OAuth configuration error.",
      },
      {
        status: 500,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}

function serializeStateCookie(state: string) {
  return [
    `${STATE_COOKIE}=${state}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/api/integrations/ticktick/oauth/callback",
    "Max-Age=600",
  ].join("; ");
}
