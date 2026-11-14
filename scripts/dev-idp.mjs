#!/usr/bin/env node

/**
 * A small OpenID Connect provider for local development and tests.
 * It signs in anyone as any address, so it must never be reachable from a network.
 * The Worker refuses a plain-http issuer unless its own host is localhost.
 *
 * Usage:
 *   node scripts/dev-idp.mjs            # listens on 127.0.0.1:8788
 *
 * An address that starts with "unverified" gets email_verified: false.
 * Add &as=<address> to the authorize URL to skip the form (tests do this).
 */

import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.env.IDP_PORT ?? 8788);
const ISSUER = `http://localhost:${PORT}`;
const KID = "dev-key";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };
const codes = new Map();

const b64url = (input) => Buffer.from(input).toString("base64url");
const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);

function idToken(claims) {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: KID }));
  const body = b64url(JSON.stringify(claims));
  const signature = sign("sha256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url");
  return `${head}.${body}.${signature}`;
}

function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

createServer(async (req, res) => {
  const url = new URL(req.url, ISSUER);

  if (url.pathname === "/.well-known/openid-configuration") {
    return json(res, 200, {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
    });
  }

  if (url.pathname === "/jwks") return json(res, 200, { keys: [jwk] });

  if (url.pathname === "/authorize") {
    const email = url.searchParams.get("as");
    if (!email) {
      const hidden = [...url.searchParams]
        .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
        .join("");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(`<!doctype html><meta charset="utf-8"><title>Dev sign-in</title>
<body style="font: 16px system-ui; margin: 3rem">
<h1 style="font-size: 1.25rem">Local sign-in</h1>
<p>This provider exists on your machine only. Type any address.</p>
<form method="get" action="/authorize">${hidden}
<label>Email <input name="as" type="email" value="admin@school.test" autofocus required></label>
<button>Sign in</button></form></body>`);
    }
    const code = randomBytes(16).toString("hex");
    codes.set(code, {
      email,
      nonce: url.searchParams.get("nonce"),
      challenge: url.searchParams.get("code_challenge"),
      clientId: url.searchParams.get("client_id"),
      redirectUri: url.searchParams.get("redirect_uri"),
    });
    const back = new URL(url.searchParams.get("redirect_uri"));
    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("state") ?? "");
    res.writeHead(302, { Location: back.toString() });
    return res.end();
  }

  if (url.pathname === "/token" && req.method === "POST") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const form = new URLSearchParams(raw);
    const grant = codes.get(form.get("code"));
    codes.delete(form.get("code"));
    const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
    if (!grant || grant.challenge !== challenge || grant.redirectUri !== form.get("redirect_uri")) {
      return json(res, 400, { error: "invalid_grant" });
    }
    const now = Math.floor(Date.now() / 1000);
    return json(res, 200, {
      token_type: "Bearer",
      access_token: "dev",
      id_token: idToken({
        iss: ISSUER,
        aud: grant.clientId,
        sub: `dev-${grant.email}`,
        iat: now,
        exp: now + 300,
        nonce: grant.nonce,
        email: grant.email,
        email_verified: !grant.email.startsWith("unverified"),
        name: grant.email.split("@")[0],
      }),
    });
  }

  res.writeHead(404);
  res.end();
}).listen(PORT, "127.0.0.1", () => console.log(`dev identity provider on ${ISSUER}`));
