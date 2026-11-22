import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { jwt } from "better-auth/plugins";

function resolveOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return String(value || "").replace(/\/+$/, "");
  }
}

function buildJwksUrl(origin) {
  try {
    return new URL("/api/auth/jwks", origin).toString();
  } catch {
    return `${String(origin).replace(/\/+$/, "")}/api/auth/jwks`;
  }
}

const rawBaseURL =
  process.env.BETTER_AUTH_URL || "http://localhost:5000";

export const AUTH_ORIGIN = resolveOrigin(rawBaseURL);
export const JWT_ISSUER = AUTH_ORIGIN;
export const JWT_AUDIENCE = AUTH_ORIGIN;
export const JWKS_URL = buildJwksUrl(AUTH_ORIGIN);

export function createAuth(db) {
  return betterAuth({
    baseURL: rawBaseURL,
    secret: process.env.BETTER_AUTH_SECRET,

    advanced: {
      defaultCookieAttributes: {
        sameSite: "lax",
        secure: AUTH_ORIGIN.startsWith("https://"),
        httpOnly: true,
      },
    },

    database: mongodbAdapter(db),

    trustedOrigins: [
      process.env.CLIENT_URL || "http://localhost:3000",
    ],

    emailAndPassword: {
      enabled: true,
      minPasswordLength: 6,
      maxPasswordLength: 128,
      requireEmailVerification: false,
    },

    // Social Authentication
    socialProviders: {
      ...(process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: process.env.GOOGLE_CLIENT_ID,
              clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            },
          }
        : {}),

      ...(process.env.GITHUB_CLIENT_ID &&
      process.env.GITHUB_CLIENT_SECRET
        ? {
            github: {
              clientId: process.env.GITHUB_CLIENT_ID,
              clientSecret: process.env.GITHUB_CLIENT_SECRET,
            },
          }
        : {}),
    },

    user: {
      additionalFields: {
        role: {
          type: "string",
          required: false,
          defaultValue: "Customer",
          input: false,
        },

        phone: {
          type: "string",
          required: false,
          defaultValue: "",
          input: true,
        },

        address: {
          type: "string",
          required: false,
          defaultValue: "",
          input: true,
        },
      },
    },

    plugins: [
      jwt({
        jwt: {
          issuer: JWT_ISSUER,
          audience: JWT_AUDIENCE,
          expirationTime: "15m",
        },
      }),
    ],
  });
}