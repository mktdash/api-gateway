import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { env } from "#config/env";
import { activeServices, type ActiveService } from "#config/service-registry";
import { logger } from "#lib/logger";

export const OPENAPI_EVENTS = {
  upstreamFetchFailed: "openapi_upstream_fetch_failed",
  schemaCollision: "openapi_schema_collision",
} as const;

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type JsonObject = Record<string, JsonValue>;

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SCHEMA_REF_PREFIX = "#/components/schemas/";

function rewriteSchemaRefs(
  value: JsonValue,
  renames: ReadonlyMap<string, string>,
): JsonValue {
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteSchemaRefs(entry, renames));
  }

  if (!isJsonObject(value)) {
    return value;
  }

  const rewritten: JsonObject = {};

  for (const [key, entry] of Object.entries(value)) {
    if (
      key === "$ref" &&
      typeof entry === "string" &&
      entry.startsWith(SCHEMA_REF_PREFIX)
    ) {
      const name = entry.slice(SCHEMA_REF_PREFIX.length);
      const renamed = renames.get(name);
      rewritten[key] =
        renamed === undefined ? entry : `${SCHEMA_REF_PREFIX}${renamed}`;
      continue;
    }

    rewritten[key] = rewriteSchemaRefs(entry, renames);
  }

  return rewritten;
}

async function fetchUpstreamDocument(
  service: ActiveService,
): Promise<JsonObject | null> {
  if (service.openapiPath === null) {
    return null;
  }

  const url = `${service.upstream.replace(/\/$/u, "")}${service.openapiPath}`;

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(env.OPENAPI_FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      logger.warn(
        {
          event: OPENAPI_EVENTS.upstreamFetchFailed,
          service: service.name,
          status: response.status,
        },
        "upstream openapi document unavailable",
      );
      return null;
    }

    const document: unknown = await response.json();
    return isJsonObject(document as JsonValue)
      ? (document as JsonObject)
      : null;
  } catch (error) {
    logger.warn(
      {
        event: OPENAPI_EVENTS.upstreamFetchFailed,
        service: service.name,
        err: error instanceof Error ? error.message : String(error),
      },
      "upstream openapi fetch failed",
    );
    return null;
  }
}

export type AggregatedDocument = JsonObject & { openapi: string };

export type AggregationResult = {
  readonly document: AggregatedDocument;
  readonly merged: readonly string[];
  readonly skipped: readonly string[];
  readonly collisions: readonly string[];
};

export function aggregateDocuments(
  documents: readonly { service: ActiveService; document: JsonObject }[],
): AggregationResult {
  const paths: JsonObject = {};
  const schemas: JsonObject = {};
  const tags: JsonObject[] = [];
  const merged: string[] = [];
  const collisions: string[] = [];
  const seenTags = new Set<string>();

  for (const { service, document } of documents) {
    const components = document.components;
    const upstreamSchemas = isJsonObject(components)
      ? components.schemas
      : undefined;
    const renames = new Map<string, string>();

    if (isJsonObject(upstreamSchemas)) {
      for (const name of Object.keys(upstreamSchemas)) {
        if (Object.hasOwn(schemas, name)) {
          const namespaced = `${service.codename.charAt(0).toUpperCase()}${service.codename.slice(1)}${name}`;
          renames.set(name, namespaced);
          collisions.push(`${service.name}:${name} -> ${namespaced}`);

          logger.warn(
            {
              event: OPENAPI_EVENTS.schemaCollision,
              service: service.name,
              schema: name,
              renamedTo: namespaced,
            },
            "openapi schema name collision; namespaced by service",
          );
        }
      }
    }

    const rewritten = rewriteSchemaRefs(document, renames);
    if (!isJsonObject(rewritten)) {
      continue;
    }

    const rewrittenComponents = rewritten.components;
    const rewrittenSchemas = isJsonObject(rewrittenComponents)
      ? rewrittenComponents.schemas
      : undefined;

    if (isJsonObject(rewrittenSchemas)) {
      for (const [name, schema] of Object.entries(rewrittenSchemas)) {
        schemas[renames.get(name) ?? name] = schema;
      }
    }

    const rewrittenPaths = rewritten.paths;
    if (isJsonObject(rewrittenPaths)) {
      for (const [path, item] of Object.entries(rewrittenPaths)) {
        if (Object.hasOwn(paths, path)) {
          logger.error(
            {
              event: OPENAPI_EVENTS.schemaCollision,
              service: service.name,
              path,
            },
            "two services claim the same openapi path",
          );
          continue;
        }
        paths[path] = item;
      }
    }

    const rewrittenTags = rewritten.tags;
    if (Array.isArray(rewrittenTags)) {
      for (const tag of rewrittenTags) {
        if (!isJsonObject(tag)) {
          continue;
        }
        const name = tag.name;
        if (typeof name !== "string" || seenTags.has(name)) {
          continue;
        }
        seenTags.add(name);
        tags.push(tag);
      }
    }

    merged.push(service.name);
  }

  return {
    document: {
      openapi: "3.1.0",
      info: {
        title: "Marketing Dashboard API",
        version: "1.0.0",
        description:
          "Aggregated from every service behind the gateway. Generated per request; do not hand-edit.",
      },
      servers: [{ url: "/", description: "api-gateway" }],
      tags,
      paths,
      components: { schemas },
    },
    merged,
    skipped: [],
    collisions,
  };
}

export const openapiRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/openapi.json",
    {
      schema: {
        operationId: "getAggregatedOpenapi",
        tags: ["docs"],
        summary: "Aggregated OpenAPI document for every active upstream",
        response: { 200: z.looseObject({ openapi: z.string() }) },
      },
    },
    async (_request, reply) => {
      const services = activeServices();

      const settled = await Promise.all(
        services.map(async (service) => ({
          service,
          document: await fetchUpstreamDocument(service),
        })),
      );

      const available = settled.flatMap(({ service, document }) =>
        document === null ? [] : [{ service, document }],
      );

      const skipped = settled
        .filter(({ document }) => document === null)
        .map(({ service }) => service.name);

      const result = aggregateDocuments(available);

      await reply
        .header("cache-control", "no-store")
        .header("x-openapi-merged", result.merged.join(",") || "none")
        .header("x-openapi-skipped", skipped.join(",") || "none")
        .send(result.document);
    },
  );
};
