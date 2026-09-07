import { z } from 'zod';

const wireVersion = 'semantic-actions-v1';
type JsonSchema = { properties?: Record<string, JsonSchema>; required?: string[]; items?: JsonSchema;
  anyOf?: JsonSchema[]; [key: string]: unknown };

function omitProperties(schema: JsonSchema, keys: string[]) {
  for (const key of keys) delete schema.properties?.[key];
  if (schema.required) schema.required = schema.required.filter(key => !keys.includes(key));
}

/** Reduce the provider contract only. Durable checkpoints retain the full runtime schema. */
export function compactSemanticDecisionFormat<T extends {format:{schema: unknown}}>(format: T): T {
  const result = structuredClone(format);
  const schema = result.format.schema as JsonSchema;
  const intent = schema.properties!.intent;
  omitProperties(intent,['turnId','requiresTools']);
  omitProperties(intent.properties!.grounding,['requiredToolKinds']);
  const event = schema.properties!.ledgerDelta.properties!.events.items!;
  omitProperties(event,['eventId','source']);
  const requests = intent.properties!.toolRequests.items!;
  for (const variant of requests.anyOf ?? [requests]) {
    if (variant.properties?.args) omitProperties(variant.properties.args,['reason','notes']);
  }
  schema.properties!.wireVersion = {type:'string',enum:[wireVersion]};
  schema.required = [...schema.required!, 'wireVersion'];
  return result;
}

/** Derive mechanics from explicitly selected actions; never choose an action or infer buyer intent. */
export function expandCompactSemanticDecision(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || !('wireVersion' in raw)) return raw;
  const wire = z.object({wireVersion:z.literal(wireVersion),
    ledgerDelta:z.object({events:z.array(z.object({}).passthrough())}).passthrough(),
    intent:z.object({toolRequests:z.array(z.object({tool:z.string(),required:z.boolean()}).passthrough()),
      grounding:z.object({}).passthrough()}).passthrough()
  }).strict().parse(raw);
  const absent = (object:Record<string,unknown>,keys:string[]) => {
    for(const key of keys)if(Object.hasOwn(object,key))throw new z.ZodError([{code:'custom',path:[key],message:`compact_wire_derived_field:${key}`}]);
  };
  absent(wire.intent,['turnId','requiresTools']);
  absent(wire.intent.grounding,['requiredToolKinds']);
  for(const event of wire.ledgerDelta.events)absent(event,['eventId','source']);
  return {
    ledgerDelta:{...wire.ledgerDelta,events:wire.ledgerDelta.events.map(event=>({...event,source:'llm_state_delta'}))},
    intent:{...wire.intent,requiresTools:wire.intent.toolRequests.length>0,
      grounding:{...wire.intent.grounding,requiredToolKinds:[...new Set(wire.intent.toolRequests.filter(t=>t.required).map(t=>t.tool))]}}
  };
}
