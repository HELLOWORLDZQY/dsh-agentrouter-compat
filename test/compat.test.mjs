import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { relayResponsesCompatPatch as patch } from '../lib/compat.js'

// All payloads and identifiers in this suite are synthetic; no credentials or I/O.
function patchObject(value) {
  const result = patch(JSON.stringify(value))
  assert.equal(typeof result, 'string', 'a changed payload must return JSON text')
  return JSON.parse(result)
}

describe('relayResponsesCompatPatch input boundaries', () => {
  const invalidJson = [
    ['empty text', ''],
    ['whitespace', ' \t\r\n'],
    ['truncated object', '{'],
    ['truncated input', '{"input":['],
    ['trailing comma', '{"input":[],}'],
    ['trailing data', '{"input":[]} synthetic'],
    ['undefined token', 'undefined'],
    ['NaN token', 'NaN'],
    ['unterminated string', '"synthetic'],
    ['BOM-prefixed JSON', '\uFEFF{"input":[],"previous_response_id":"resp_synthetic"}'],
  ]
  for (const [name, text] of invalidJson) {
    test(`passes through malformed JSON: ${name}`, () => {
      assert.equal(patch(text), undefined)
    })
  }

  for (const text of ['null', 'true', 'false', '42', '"synthetic"', '[]', '[{"id":"msg_synthetic"}]']) {
    test(`does not treat a JSON primitive or root array as a request: ${text}`, () => {
      assert.equal(patch(text), undefined)
    })
  }

  const nonStrings = [
    ['undefined', undefined],
    ['null', null],
    ['boolean', false],
    ['number', 17],
    ['bigint', 17n],
    ['symbol', Symbol('synthetic')],
    ['boxed string', new String('{"input":[],"previous_response_id":"resp_synthetic"}')],
    ['array', []],
    ['function', () => {}],
    ['object with coercion trap', { toString() { assert.fail('must not coerce input to text') } }],
  ]
  for (const [name, value] of nonStrings) {
    test(`does not coerce a non-string argument: ${name}`, () => {
      assert.equal(patch(value), undefined)
    })
  }

  test('does not mutate or serialize an object argument', () => {
    const value = Object.freeze({
      previous_response_id: 'resp_synthetic_previous',
      input: Object.freeze([Object.freeze({ id: 'msg_synthetic_keep' })]),
    })
    assert.equal(patch(value), undefined)
    assert.equal(value.previous_response_id, 'resp_synthetic_previous')
    assert.equal(value.input[0].id, 'msg_synthetic_keep')
  })

  const nonArrayInputs = [
    ['missing', {}],
    ['null', { input: null }],
    ['string', { input: 'synthetic prompt' }],
    ['object', { input: { id: 'msg_synthetic_keep' } }],
    ['number', { input: 0 }],
    ['boolean', { input: false }],
  ]
  for (const [name, fields] of nonArrayInputs) {
    test(`requires array input before removing previous_response_id: ${name}`, () => {
      const text = JSON.stringify({ previous_response_id: 'resp_synthetic_keep', ...fields })
      assert.equal(patch(text), undefined)
    })
  }
})

describe('relayResponsesCompatPatch replay-handle cleanup', () => {
  const previousValues = [
    ['string', 'resp_synthetic_previous'],
    ['empty string', ''],
    ['null', null],
    ['number', 123],
    ['boolean', false],
    ['object', { id: 'resp_synthetic_previous' }],
    ['array', ['resp_synthetic_previous']],
  ]
  for (const [name, previous_response_id] of previousValues) {
    test(`removes an own previous_response_id even with empty input: ${name}`, () => {
      assert.deepEqual(patchObject({ previous_response_id, input: [], model: 'synthetic-model' }), {
        input: [], model: 'synthetic-model',
      })
    })
  }

  for (const id of ['', 'msg_synthetic_item', 'call_synthetic_shared', 'id_synthetic_中文']) {
    test(`removes every string item id without prefix filtering: ${JSON.stringify(id)}`, () => {
      assert.deepEqual(patchObject({ input: [{ id, type: 'synthetic_extension', call_id: id }] }), {
        input: [{ type: 'synthetic_extension', call_id: id }],
      })
    })
  }

  const nonStringIds = [
    ['null', null], ['zero', 0], ['number', 123], ['false', false], ['true', true],
    ['array', ['id_synthetic_nested']], ['object', { id: 'id_synthetic_nested' }],
  ]
  for (const [name, id] of nonStringIds) {
    test(`preserves non-string item id: ${name}`, () => {
      const input = [{ type: 'synthetic_extension', id }]
      assert.equal(patch(JSON.stringify({ input })), undefined)
      assert.deepEqual(patchObject({ previous_response_id: 'resp_synthetic_remove', input }), { input })
    })
  }

  test('drops all direct item_reference objects, including missing or non-string IDs, in order', () => {
    const retained = [
      null,
      false,
      0,
      'synthetic scalar input',
      [{ type: 'item_reference', id: 'id_synthetic_inside_array' }],
      { type: 'ITEM_REFERENCE', note: 'case-sensitive type' },
      { type: 'item_reference_suffix', note: 'exact type only' },
      { role: 'user', content: 'synthetic survivor' },
      { type: 'synthetic_extension', nested: { type: 'item_reference', id: 'id_synthetic_nested' } },
    ]
    const input = [
      { type: 'item_reference', id: 'msg_synthetic_remove' },
      ...retained.slice(0, 3),
      { type: 'item_reference' },
      ...retained.slice(3, 6),
      { type: 'item_reference', id: 123, content: 'synthetic reference-only content' },
      ...retained.slice(6),
      { type: 'item_reference', id: null },
    ]
    assert.deepEqual(patchObject({ input }), { input: retained })
  })

  test('removes IDs from objects regardless of item type or whether type is present', () => {
    const retained = [{ content: 'synthetic no type' }, { type: null }, { type: 123 }]
    const input = retained.map((item, index) => ({ ...item, id: `item_synthetic_${index}` }))
    assert.deepEqual(patchObject({ input }), { input: retained })
  })

  test('preserves all content, nested IDs, file IDs, encrypted reasoning and tool schemas', () => {
    const schema = {
      $id: 'schema_synthetic_keep',
      type: 'object',
      properties: {
        id: { type: 'string', const: 'schema_id_synthetic_keep' },
        file_id: { type: 'string' },
        previous_response_id: { type: 'string' },
      },
      required: ['id', 'file_id'],
      additionalProperties: false,
    }
    const retained = [
      {
        type: 'message', role: 'user',
        content: [
          { type: 'input_text', id: 'part_synthetic_keep', text: '正文 synthetic: {"id":"msg_synthetic_literal","previous_response_id":"resp_synthetic_literal"}\n☃' },
          { type: 'input_file', id: 'part_synthetic_file_keep', file_id: 'file_synthetic_keep', filename: 'synthetic.txt' },
        ],
        metadata: { id: 'metadata_synthetic_keep', previous_response_id: 'resp_synthetic_nested_keep' },
      },
      {
        type: 'reasoning', encrypted_content: 'synthetic-encrypted-content-not-a-secret',
        summary: [{ type: 'summary_text', id: 'summary_synthetic_keep', text: 'synthetic summary' }],
        call_id: 'call_synthetic_reasoning_keep',
      },
      {
        type: 'function_call', call_id: 'call_synthetic_shared', name: 'synthetic_lookup',
        arguments: '{ "id": "arg_synthetic_keep", "file_id": "file_synthetic_argument", "previous_response_id": "resp_synthetic_argument" }',
      },
      {
        type: 'function_call_output', call_id: 'call_synthetic_shared',
        output: 'synthetic output with id=msg_synthetic_literal', file_id: 'file_synthetic_direct_keep',
      },
      {
        type: 'synthetic_extension',
        output: { id: 'output_synthetic_keep', nested: [{ type: 'item_reference', id: 'reference_synthetic_nested_keep' }] },
      },
    ]
    const envelope = {
      id: 'request_synthetic_keep', model: 'synthetic-model', stream: true,
      instructions: 'Keep literal previous_response_id=resp_synthetic_literal and id=msg_synthetic_literal.',
      tools: [{ type: 'function', name: 'synthetic_lookup', parameters: schema }],
      text: { format: { type: 'json_schema', name: 'synthetic_schema', schema } },
      metadata: { id: 'envelope_synthetic_keep' },
    }
    const input = retained.map((item, index) => ({ ...item, id: `item_synthetic_remove_${index}` }))
    input.splice(2, 0, { type: 'item_reference', id: 'reference_synthetic_remove' })
    const result = patchObject({ ...envelope, previous_response_id: 'resp_synthetic_remove', input })
    assert.deepEqual(result, { ...envelope, input: retained })
    assert.equal(result.input[2].call_id, result.input[3].call_id)
    assert.equal(result.input[2].arguments, retained[2].arguments)
    assert.equal(result.input[1].encrypted_content, retained[1].encrypted_content)
  })

  test('keeps JSON __proto__ and constructor data without prototype pollution', () => {
    const text = '{"input":[{"id":"msg_synthetic_remove","__proto__":{"id":"nested_synthetic_keep","synthetic_polluted":true},"constructor":{"id":"constructor_synthetic_keep"}}]}'
    const result = JSON.parse(patch(text))
    assert.equal(Object.hasOwn(result.input[0], 'id'), false)
    assert.equal(Object.hasOwn(result.input[0], '__proto__'), true)
    assert.deepEqual(result.input[0].__proto__, { id: 'nested_synthetic_keep', synthetic_polluted: true })
    assert.deepEqual(result.input[0].constructor, { id: 'constructor_synthetic_keep' })
    assert.equal(Object.hasOwn(Object.prototype, 'synthetic_polluted'), false)
  })
})

describe('relayResponsesCompatPatch no-op bytes and idempotence', () => {
  const unchanged = [
    ['empty input', ' { "input" : [ ] }\r\n'],
    ['numeric spelling and escapes', '{\n  "number": 1.2300e+02, "text": "\\u4e2d\\n", "input": []\n}'],
    ['duplicate keys', '{ "input": [], "synthetic": 1, "synthetic": 2 }'],
    ['nested IDs only', '{ "id":"request_synthetic_keep", "input":[{"content":[{"id":"nested_synthetic_keep","file_id":"file_synthetic_keep"}],"call_id":"call_synthetic_keep"}] }'],
    ['non-string IDs and scalar entries', '{ "input": [ null, 0, false, "synthetic", [], {"id":123}, {"id":null} ] }'],
    ['nested reference only', '{ "input":[{"nested":{"type":"item_reference","id":"nested_synthetic_keep"}}] }'],
  ]
  for (const [name, text] of unchanged) {
    test(`returns undefined instead of reserializing unchanged JSON: ${name}`, () => {
      assert.equal(patch(text), undefined)
      assert.equal(patch(text) ?? text, text)
    })
  }

  const changed = [
    ['previous_response_id alone', { previous_response_id: 'resp_synthetic_remove', input: [] }],
    ['item id alone', { input: [{ id: 'msg_synthetic_remove', content: 'synthetic text' }] }],
    ['reference alone', { input: [{ type: 'item_reference', id: 'reference_synthetic_remove' }] }],
    ['mixed replay handles', {
      previous_response_id: 'resp_synthetic_remove',
      input: [
        { type: 'item_reference', id: 'reference_synthetic_remove' },
        { id: 'msg_synthetic_remove', content: [{ id: 'part_synthetic_keep', text: 'synthetic text' }] },
        { id: 123, call_id: 'call_synthetic_keep' },
        null,
      ],
    }],
  ]
  for (const [name, value] of changed) {
    test(`is idempotent after cleanup: ${name}`, () => {
      const result = patch(JSON.stringify(value, null, 2))
      assert.equal(typeof result, 'string')
      assert.equal(patch(result), undefined)
      assert.equal(patch(result) ?? result, result)
      assert.equal(patch(patch(result) ?? result), undefined)
    })
  }
})
