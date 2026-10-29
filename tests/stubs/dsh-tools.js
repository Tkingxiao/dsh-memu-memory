// A faithful stand-in for the host's `defineTool`: it compiles tool schemas with
// the same value-schema DSL rules as @deepseek-ai/dsh-tools, so a schema the real
// host rejects fails here too. The previous stub was `return spec`, which meant
// 320 green tests could not see that the host refused every one of the ten tools.
//
// Rules mirrored from packages/core/tools/src/schema.ts (host):
//  - annotations are description/title/default/examples;
//  - an object node needs an explicit boolean `additionalProperties`;
//  - an array node accepts only type/items (annotations allowed), and its items are
//    compiled WITHOUT `required` — nested required must be inline `required: true`;
//  - `required` on a property must be the literal `true`;
//  - any other key is rejected.

const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples']

function assertAuthorKeys(source, path, allowed) {
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) {
      throw new Error(`${path}.${key} is not supported by the value schema DSL`)
    }
  }
}

function compileValueSchema(source, path, { allowRequired = false } = {}) {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error(`${path} must be a value schema object`)
  }
  const type = source.type
  switch (type) {
    case 'object': {
      assertAuthorKeys(source, path, [
        ...ANNOTATION_KEYS,
        ...(allowRequired ? ['required'] : []),
        'type', 'properties', 'additionalProperties',
      ])
      if (allowRequired && Object.hasOwn(source, 'required') && source.required !== true) {
        throw new Error(`${path}.required must be true when present`)
      }
      if (typeof source.additionalProperties !== 'boolean') {
        throw new Error(`${path}.additionalProperties must be explicitly true or false`)
      }
      const properties = source.properties ?? {}
      if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
        throw new Error(`${path}.properties must be a property map`)
      }
      for (const [key, value] of Object.entries(properties)) {
        compileValueSchema(value, `${path}.properties.${key}`, { allowRequired: true })
      }
      return { type: 'object', additionalProperties: source.additionalProperties, properties }
    }
    case 'array': {
      assertAuthorKeys(source, path, [...ANNOTATION_KEYS, 'type', 'items'])
      if (source.items === undefined) throw new Error(`${path}.items must be a value schema`)
      compileValueSchema(source.items, `${path}.items`, { allowRequired: false })
      return { type: 'array', items: source.items }
    }
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null': {
      assertAuthorKeys(source, path, [
        ...ANNOTATION_KEYS,
        ...(allowRequired ? ['required'] : []),
        'type', 'enum', 'const',
      ])
      if (allowRequired && Object.hasOwn(source, 'required') && source.required !== true) {
        throw new Error(`${path}.required must be true when present`)
      }
      return { type }
    }
    default:
      throw new Error(`${path}.type ${JSON.stringify(type)} is not supported by the value schema DSL`)
  }
}

function compileParameterSchema(parameters, path = 'parameters') {
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw new Error(`${path} must be a property map`)
  }
  // The host compiles the implicit open parameter object: extra keys are allowed.
  for (const [key, value] of Object.entries(parameters)) {
    compileValueSchema(value, `${path}.${key}`, { allowRequired: true })
  }
  return parameters
}

export function defineTool(options) {
  if (options === null || typeof options !== 'object') throw new Error('defineTool requires an options object')
  if (typeof options.name !== 'string' || !options.name) throw new Error('defineTool requires a non-empty name')
  if (typeof options.description !== 'string') throw new Error(`${options.name}: defineTool requires a description`)
  if (typeof options.timeoutMs !== 'number' || !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error(`${options.name}: timeoutMs must be a positive finite number`)
  }
  if (typeof options.execute !== 'function') throw new Error(`${options.name}: defineTool requires an execute function`)
  compileParameterSchema(options.parameters)
  const outputSchema = options.output?.schema
  if (outputSchema === undefined) throw new Error(`${options.name}: defineTool requires output.schema`)
  compileValueSchema(outputSchema, `${options.name}.output.schema`, { allowRequired: false })
  return options
}
