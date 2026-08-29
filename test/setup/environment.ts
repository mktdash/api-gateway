import { afterAll, inject } from "vitest";
import { UpstreamStub } from "../helpers/upstream-stub.ts";

process.env.JWKS_URI = inject("jwksUri");

export const upstream = new UpstreamStub();

await upstream.start();

process.env.IDENTITY_SERVICE_URL = upstream.origin;

afterAll(async () => {
  await upstream.stop();
});
