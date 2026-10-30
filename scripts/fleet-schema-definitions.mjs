// Read the exact published definitions. This command never proposes or publishes a schema.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [control, candidate, lastdbSource, output] = process.argv.slice(2);
const environment = process.env.ROUTINES_SCHEMA_ENV;
if (process.env.GITHUB_ACTIONS !== "true" || !control || !candidate || !lastdbSource || !output || !["dev", "prod"].includes(environment)) {
  throw Error("Use this read-only definition check in CI with exact source paths and an output path");
}
const endpoints = JSON.parse(readFileSync(join(resolve(lastdbSource), "folddb_profile/environments.json"), "utf8"));
const service = endpoints.environments[environment].schema_service;
const controlRules = readFileSync(join(resolve(control), "src/status-schema.ts"));
const candidateRules = readFileSync(join(resolve(candidate), "src/status-schema.ts"));
if (!controlRules.equals(candidateRules)) throw Error("The two arms do not use the same canonical vocabulary");
const { SCHEMAS, canonicalDefinition, definitionIdentity } = await import(join(resolve(candidate), "src/status-schema.ts"));
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const results = await Promise.all(Object.keys(SCHEMAS).map(async key => {
  const schema = canonicalDefinition(key), identity = definitionIdentity(schema);
  try {
    const response = await fetch(`${service}/v1/schema/${identity}`, {
      signal: AbortSignal.timeout(60000),
    });
    const raw = await response.json(), body = raw.data ?? raw, stored = body.schema ?? body;
    const exact = response.status === 200 && stored.identity_hash === identity && stored.owner_app_id === schema.owner_app_id &&
      stored.descriptive_name === schema.descriptive_name && stored.schema_type === schema.schema_type &&
      same([stored.key?.hash_field, stored.key?.range_field ?? null], [schema.key.hash_field, schema.key.range_field ?? null]) &&
      same([...(stored.fields ?? [])].sort(), [...schema.fields].sort()) &&
      same(stored.field_types, schema.field_types) && same(stored.field_descriptions, schema.field_descriptions) &&
      same(stored.field_data_classifications, schema.field_data_classifications) && Object.keys(stored.transform_fields ?? {}).length === 0;
    // Published field definitions cross the native schema boundary. Historical
    // global value mappers do not grant authority over locally owned values.
    return { key, schema: schema.descriptive_name, identity, status: response.status, exact_field_definition: exact,
      published_mapper_fields: Object.keys(stored.field_mappers ?? {}).sort(), published_value_authority: false, response: body };
  } catch (error) {
    return { key, schema: schema.descriptive_name, identity, exact_field_definition: false, error: String(error) };
  }
}));
const complete = results.length === 6 && results.every(item => item.exact_field_definition);
writeFileSync(output, JSON.stringify({ complete, environment, service, definitions: results }, null, 2) + "\n");
for (const { response, ...result } of results) console.log(JSON.stringify(result));
if (!complete) throw Error("The exact six Routines definitions must pass normal publication before build or measurement");
