import { createServer, type Server } from "node:http";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    jwksPrivateKeyPkcs8: string;
    jwksKid: string;
    foreignPrivateKeyPkcs8: string;
    jwksUri: string;
  }
}

let server: Server | undefined;

export default async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  const signing = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
    extractable: true,
  });
  const foreign = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
    extractable: true,
  });

  const kid = "test-signing-key";
  const publicJwk = await exportJWK(signing.publicKey);

  const jwks = {
    keys: [{ ...publicJwk, kid, alg: "EdDSA", use: "sig" }],
  };

  project.provide("jwksPrivateKeyPkcs8", await exportPKCS8(signing.privateKey));
  project.provide("jwksKid", kid);
  project.provide(
    "foreignPrivateKeyPkcs8",
    await exportPKCS8(foreign.privateKey),
  );

  server = createServer((request, response) => {
    if (request.url?.startsWith("/.well-known/jwks.json") === true) {
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "public, max-age=300",
      });
      response.end(JSON.stringify(jwks));
      return;
    }

    response.writeHead(404).end();
  });

  await new Promise<void>((resolve) => {
    server?.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("the JWKS stub did not bind a TCP port");
  }

  project.provide(
    "jwksUri",
    `http://127.0.0.1:${String(address.port)}/.well-known/jwks.json`,
  );

  return async () => {
    await new Promise<void>((resolve) => {
      if (server === undefined) {
        resolve();
        return;
      }
      server.close(() => {
        resolve();
      });
    });
  };
}
