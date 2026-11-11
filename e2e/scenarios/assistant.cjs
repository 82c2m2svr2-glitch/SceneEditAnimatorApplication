// Drives the assistant against a mocked OpenAI API to verify the whole tool loop.
const assert = require('node:assert');

module.exports = async (page, ctx) => {
  let turn = 0;
  const sse = (chunks) => chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n';
  const toolCall = (id, name, args) => [
    { choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args).slice(0, 10) } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args).slice(10) } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
  const script = [
    toolCall('c1', 'get_scene', {}),
    toolCall('c2', 'create_shape', { kind: 'ellipse', name: 'Sun', x: 1500, y: 220, width: 220, height: 220, fill: '#ffd166', depth: 400 }),
    toolCall('c3', 'create_shape', { kind: 'path', name: 'Hills', path: 'M0 800 Q480 560 960 760 T1920 700 L1920 1080 L0 1080 Z', fill: '#2d6a4f', behind: true }),
    toolCall('c4', 'apply_action', { character: 'Hero', action: 'Wave', startFrame: 10 }),
    toolCall('c5', 'set_keyframes', { keys: [{ node: 'Hero', property: 'x', frame: 0, value: 400 }, { node: 'Hero', property: 'x', frame: 60, value: 1100, ease: 'easeOut' }] }),
    toolCall('c6', 'look', { frame: 30 }),
    toolCall('c7', 'pose', { character: 'Nobody', bones: {} }),
    [{ choices: [{ delta: { content: 'Added a sun and hills, ' } }] }, { choices: [{ delta: { content: 'and Hero walks in and waves.' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }],
  ];
  const bodies = [];
  await page.route('https://api.openai.com/v1/chat/completions', async (route) => {
    bodies.push(JSON.parse(route.request().postData()));
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse(script[Math.min(turn++, script.length - 1)]) });
  });
  await page.getByRole('button', { name: /Create project/ }).click();
  await page.waitForTimeout(500);
  await page.evaluate(() => window.df.useSettings.getState().update({ openaiKey: 'sk-test', assistantProvider: 'openai' }));
  await page.locator('.chat-input textarea').fill('Make a sunny scene and have Hero walk in and wave');
  await page.locator('.chat-input textarea').press('Enter');
  await page.waitForFunction(() => !document.querySelector('.chat .spin'), null, { timeout: 15000 });
  await page.waitForTimeout(300);
  const info = await page.evaluate(() => {
    const s = window.df.commands.scene();
    return { roots: s.roots.map((id) => s.nodes[id].name), strips: s.strips.length, heroAnim: Object.keys(s.anim[s.roots.find((id) => s.nodes[id].name === 'Hero')] || {}), undo: window.df.doc.undoStack.map((e) => e.label + ':' + e.source) };
  });
  assert.deepStrictEqual(info.roots, ['Hills', 'Hero', 'Sun']);
  assert.strictEqual(info.strips, 1);
  assert.deepStrictEqual(info.heroAnim, ['x']);
  assert.ok(info.undo.slice(1).every((l) => l.endsWith(':ai')), 'assistant changes are tagged in the undo history');
  const last = bodies[bodies.length - 1].messages;
  assert.match(last.filter((m) => m.role === 'tool').pop().content, /No layer matches "Nobody"/);
  assert.ok(last.some((m) => m.role === 'user' && Array.isArray(m.content)), 'the look tool image is sent back to the model');
  assert.ok(bodies[0].tools.length >= 25);
  await page.evaluate(() => window.df.useUI.setState({ frame: 30 }));
};
