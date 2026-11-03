/** Provider-only projection. Internal contracts and post-parse validation stay intact. */
const unsupported = new Set([
  'uniqueItems', 'patternProperties', 'propertyNames', 'minProperties', 'maxProperties',
  'contains', 'minContains', 'maxContains', 'if', 'then', 'else', 'not',
  'dependentRequired', 'dependentSchemas', 'dependencies', 'unevaluatedProperties',
  'unevaluatedItems', 'additionalItems', 'allOf', 'oneOf',
]);

/** Walk schema positions, not property names or literal enum/const/default values. */
export function providerOutputSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(providerOutputSchema);
  if (schema === null || typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(schema).filter(([key]) => !unsupported.has(key)).map(([key, value]) => {
    if (['properties', '$defs', 'definitions'].includes(key) && value && typeof value === 'object') {
      return [key, Object.fromEntries(Object.entries(value).map(([name, child]) => [name, providerOutputSchema(child)]))];
    }
    return [key, ['items', 'anyOf', 'additionalProperties'].includes(key) ? providerOutputSchema(value) : structuredClone(value)];
  }));
}
