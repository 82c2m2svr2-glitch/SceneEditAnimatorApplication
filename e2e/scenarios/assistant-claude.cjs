// Drives the assistant through the Anthropic provider against a mocked Messages API.
const assert = require('node:assert');

module.exports = async (page, ctx) => {
  let turn = 0;
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const msgStart = ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  const toolTurn = (id, name, input) => msgStart +
    ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }) +
    ev('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig' } }) +
    ev('content_block_stop', { index: 0 }) +
    ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id, name, input: {} } }) +
    ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input).slice(0, 7) } }) +
    ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input).slice(7) } }) +
    ev('content_block_stop', { index: 1 }) +
    ev('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } }) + ev('message_stop', {});
  const textTurn = (text) => msgStart +
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }) +
    ev('content_block_stop', { index: 0 }) +
    ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } }) + ev('message_stop', {});
  const script = [toolTurn('tu_1', 'create_text', { text: 'Hello from Claude', y: 200, size: 96 }), toolTurn('tu_2', 'add_particles', { preset: 'snow' }), textTurn('Added a title and snow.')];
  const bodies = []; const headers = [];
  await page.route('https://api.anthropic.com/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    bodies.push(JSON.parse(req.postData())); headers.push(req.url() + ' beta=' + (req.headers()['anthropic-beta'] || ''));
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: script[Math.min(turn++, script.length - 1)] });
  });
  await page.getByRole('button', { name: /Create project/ }).click();
  await page.waitForTimeout(500);
  await page.evaluate(() => window.df.useSettings.getState().update({ anthropicKey: 'sk-ant-test', assistantProvider: 'anthropic', aiMode: 'ask' }));
  await page.locator('.chat-input textarea').fill('Add a title and make it snow');
  await page.locator('.chat-input textarea').press('Enter');
  await page.getByRole('button', { name: /Apply/ }).click({ timeout: 10000 });
  await page.getByRole('button', { name: /Decline/ }).click({ timeout: 10000 });
  await page.waitForFunction(() => !document.querySelector('.chat .spin'), null, { timeout: 15000 });
  await page.waitForTimeout(300);
  const roots = await page.evaluate(() => { const s = window.df.commands.scene(); return s.roots.map((id) => s.nodes[id].name); });
  assert.deepStrictEqual(roots, ['Hero', 'Hello from Claude'], 'approved change applied, declined change not applied');
  assert.ok(headers.every((h) => h.includes('server-side-fallback')));
  const b = bodies[bodies.length - 1];
  assert.strictEqual(b.model, 'claude-opus-5-5');
  assert.deepStrictEqual(b.thinking, { type: 'adaptive' });
  assert.strictEqual(b.fallbacks, 'default');
  assert.strictEqual(b.stream, true);
  assert.strictEqual(b.tools[0].eager_input_streaming, true);
  assert.deepStrictEqual(b.messages[1].content.map((c) => c.type), ['thinking', 'tool_use'], 'thinking blocks are passed back unchanged');
  assert.strictEqual(b.messages[b.messages.length - 1].content[0].is_error, true);
  assert.deepStrictEqual(await page.locator('.chat .note.err').allTextContents(), []);
  await page.evaluate(() => window.df.useSettings.getState().update({ aiMode: 'auto', assistantProvider: 'openai' }));
};
