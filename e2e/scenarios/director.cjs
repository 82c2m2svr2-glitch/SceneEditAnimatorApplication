// Claude directing a shot with the full toolset, then learning from a "meh" rating: it reviews its
// own work, fixes it, saves a lesson, and the lesson is carried into the next conversation.
const assert = require('node:assert');

module.exports = async (page) => {
  let turn = 0;
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const msgStart = ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  const toolTurn = (name, input) => msgStart +
    ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `tu_${turn}_${name}`, name, input: {} } }) +
    ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }) +
    ev('content_block_stop', { index: 0 }) +
    ev('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } }) + ev('message_stop', {});
  const textTurn = (text) => msgStart +
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }) +
    ev('content_block_stop', { index: 0 }) +
    ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } }) + ev('message_stop', {});
  const script = [
    // First request: build the shot.
    () => toolTurn('add_character', { name: 'Pip', style: '3d', x: 500, view: 'side' }),
    () => toolTurn('apply_action', { character: 'Pip', action: 'walk', start: 0, duration: 48 }),
    () => toolTurn('set_joint_3d', { node: 'Pip', joint: 'head', y: 35, frame: 40, key: true }),
    () => toolTurn('add_3d_shape', { shape: 'sphere', name: 'Ball', color: '#e4572e', x: 1300, y: 800, size: 220 }),
    () => toolTurn('list_assets', {}),
    () => toolTurn('look', { frame: 24 }),
    () => textTurn('Pip walks in and glances at a ball. What should the ending be?'),
    // After the "meh" rating: review, fix, remember.
    () => toolTurn('look', { frame: 10 }),
    () => toolTurn('set_keyframes', { keys: [{ node: 'Pip', property: 'x', frame: 0, value: 300 }, { node: 'Pip', property: 'x', frame: 48, value: 700 }] }),
    () => toolTurn('remember', { lesson: 'This user wants characters to travel across the stage, never walk on the spot.', topic: 'walk cycles' }),
    () => textTurn('The walk was on the spot, so Pip now travels. Should the camera follow?'),
    // New conversation.
    () => textTurn('Ready.'),
  ];
  const bodies = [];
  await page.route('https://api.anthropic.com/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    bodies.push(JSON.parse(req.postData()));
    const body = script[Math.min(turn, script.length - 1)]();
    turn++;
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body });
  });
  await page.getByRole('button', { name: /Create project/ }).click();
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    localStorage.removeItem('dreamforge.memory.v1');
    window.df.commands.deleteNodes(Object.keys(window.df.commands.scene().nodes));
    window.df.useSettings.getState().update({ anthropicKey: 'sk-ant-test', assistantProvider: 'anthropic', aiMode: 'auto' });
  });
  const idle = () => page.waitForFunction(() => !document.querySelector('.chat .spin'), null, { timeout: 30000 });
  const input = page.locator('.chat-input textarea');
  await input.fill('Direct a short shot: Pip walks in and notices a ball');
  await input.press('Enter');
  await page.locator('.feedback').waitFor({ timeout: 30000 }).catch(async (err) => { throw new Error(`${err.message}\nChat: ${(await page.locator('.chat-log').innerText()).slice(-900)}`); });
  assert.deepStrictEqual(await page.locator('.chat .toolcall.fail').allTextContents(), [], 'no tool call failed');
  assert.deepStrictEqual(await page.locator('.chat .note.err').allTextContents(), []);

  const built = await page.evaluate(() => {
    const s = window.df.commands.scene();
    const nodes = Object.values(s.nodes);
    const pip = nodes.find((n) => n.name === 'Pip');
    const body = nodes.find((n) => n.type === 'model3d' && n.parent === pip.id);
    return {
      pip: pip.type, view: pip.currentView, strips: s.strips.length,
      headTurn: (s.anim[body.id]?.['j:head:y']?.keys ?? []).map((k) => [k.f, k.v]),
      ball: nodes.some((n) => n.name === 'Ball' && n.type === 'model3d'),
    };
  });
  assert.deepStrictEqual(built, { pip: 'character', view: 'side', strips: 1, headTurn: [[40, 35]], ball: true });
  // The model was offered every tool, and the picture it asked for was sent back to it.
  const names = bodies[0].tools.map((t) => t.name);
  for (const t of ['add_character', 'add_3d_shape', 'set_joint_3d', 'generate_asset', 'trace_image', 'image_to_3d', 'lip_sync_audio', 'list_assets', 'place_asset', 'remember', 'get_memory', 'look', 'set_camera', 'apply_action']) assert.ok(names.includes(t), `tool ${t} is offered`);
  const afterLook = bodies[6].messages.at(-1).content[0];
  assert.strictEqual(afterLook.type, 'tool_result');
  assert.ok(afterLook.content.some((c) => c.type === 'image'), 'look returned a picture');
  assert.match(bodies[0].system[0].text, /Directing an animation/);
  assert.doesNotMatch(bodies[0].system[0].text, /What you remember/);

  // Rate it "meh" with a comment.
  await page.locator('.feedback input').fill('she just walks on the spot');
  await page.getByRole('button', { name: 'Meh', exact: true }).click();
  await idle();
  await page.locator('.feedback').waitFor({ timeout: 30000 });
  assert.deepStrictEqual(await page.locator('.chat .toolcall.fail').allTextContents(), [], 'no tool call failed while revising');
  const feedbackMessage = bodies[7].messages.at(-1).content;
  assert.match(feedbackMessage, /MEH/);
  assert.match(feedbackMessage, /she just walks on the spot/);
  assert.match(feedbackMessage, /Call remember/);
  assert.ok((await page.locator('.chat .msg.user').allTextContents()).includes('Rated meh: she just walks on the spot'), 'the chat shows the short form');
  const memory = await page.evaluate(() => JSON.parse(localStorage.getItem('dreamforge.memory.v1')));
  assert.strictEqual(memory.lessons.length, 1);
  assert.strictEqual(memory.lessons[0].topic, 'walk cycles');
  assert.deepStrictEqual(memory.feedback.map((f) => [f.rating, f.comment, f.request]), [['meh', 'she just walks on the spot', 'Direct a short shot: Pip walks in and notices a ball']]);
  const travelled = await page.evaluate(() => {
    const s = window.df.commands.scene();
    const pip = Object.values(s.nodes).find((n) => n.name === 'Pip');
    return (s.anim[pip.id]?.x?.keys ?? []).map((k) => k.v);
  });
  assert.deepStrictEqual(travelled, [300, 700]);

  // The memory viewer shows the lesson; a good rating without a comment is recorded without a model call.
  await page.locator('.chat-input .chip', { hasText: '1' }).click();
  await page.locator('.dialog').getByText('never walk on the spot').waitFor();
  await page.locator('.dialog').getByRole('button', { name: 'Done' }).click();
  const callsBefore = bodies.length;
  await page.getByRole('button', { name: 'Good', exact: true }).click();
  await page.getByText('Rated good. Saved to memory.').waitFor();
  assert.strictEqual(bodies.length, callsBefore);

  // A new conversation starts with the lesson in its instructions.
  await page.getByTitle('New conversation').click();
  await input.fill('hello');
  await input.press('Enter');
  await page.getByText('Ready.').waitFor({ timeout: 15000 });
  const system = bodies.at(-1).system[0].text;
  assert.match(system, /What you remember/);
  assert.match(system, /\[walk cycles\] This user wants characters to travel across the stage/);
  assert.match(system, /MEH: asked for "Direct a short shot/);
  await page.evaluate(() => {
    localStorage.removeItem('dreamforge.memory.v1');
    window.df.useSettings.getState().update({ assistantProvider: 'openai' });
  });
};
