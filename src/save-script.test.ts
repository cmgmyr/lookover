import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import { renderPage } from './page.ts';
import type { Item } from './store.ts';

function submitHarness(reply: () => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>) {
  class CardForm {
    dataset: Record<string, string> = {};
    matches(selector: string) { return selector === 'form.card'; }
    closest() { return null; }
    querySelectorAll(selector: string) { return selector === 'button' ? buttons : fields; }
  }
  const buttons = [{ disabled: false }, { disabled: false }];
  const fields = [{ readOnly: false }, { readOnly: false }];
  const calls: string[] = [];
  const toast = { textContent: '', classList: { add: () => undefined, remove: () => undefined } };
  let submit: ((event: { target: CardForm; preventDefault: () => void; submitter?: { name: string; value: string } }) => Promise<void>) | undefined;
  const form = new CardForm();
  const html = renderPage({
    projects: [], current: 'all',
    open: [{ id: 7, project_id: 1, title: 'Open card', details: '', source: 'lane', url: null, ref: null, retest_of: null, sort: null, status: 'open', verdict: null, feedback: null, created_at: '', feedback_at: null, processed_at: null, processed_note: null } satisfies Item],
    waiting: [], done: [], counts: new Map(),
  });
  const script = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
  const context = {
    document: {
      addEventListener: (type: string, handler: typeof submit) => { if (type === 'submit') submit = handler; },
      getElementById: () => toast,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    HTMLFormElement: CardForm,
    HTMLElement: class {},
    HTMLInputElement: class {},
    Element: class {},
    FormData: class { set() {} },
    setInterval: () => 0,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    URL,
    fetch: (url: string) => { calls.push(url); return reply(); },
    Error,
    TypeError,
  };
  vm.runInNewContext(script, context);
  const dispatch = () => submit?.({ target: form, preventDefault: () => undefined, submitter: { name: 'verdict', value: 'approved' } }) ?? Promise.resolve();
  return { calls, buttons, fields, dispatch, form };
}

test('a second submit while the rendered card request is pending sends no second request', async () => {
  let release: (value: { ok: boolean; status: number; json: () => Promise<unknown> }) => void = () => undefined;
  const pending = new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>((resolve) => { release = resolve; });
  const run = submitHarness(() => pending);
  const first = run.dispatch();
  const second = run.dispatch();
  assert.equal(run.calls.length, 1);
  release({ ok: false, status: 500, json: async () => ({ ok: false }) });
  await Promise.all([first, second]);
});

test('a rejected fetch restores controls and allows a retry request', async () => {
  let calls = 0;
  const run = submitHarness(() => ++calls === 1 ? Promise.reject(new TypeError('offline')) : Promise.resolve({ ok: false, status: 500, json: async () => ({ ok: false }) }));
  await run.dispatch();
  assert.ok(run.buttons.every((button) => !button.disabled));
  assert.ok(run.fields.every((field) => !field.readOnly));
  await run.dispatch();
  assert.equal(run.calls.length, 2);
});

test('non-2xx and ok:false replies restore controls and allow retry requests', async () => {
  for (const failedReply of [
    { ok: false, status: 500, json: async () => ({ ok: true }) },
    { ok: true, status: 200, json: async () => ({ ok: false }) },
  ]) {
    let calls = 0;
    const run = submitHarness(() => ++calls === 1 ? Promise.resolve(failedReply) : Promise.resolve({ ok: false, status: 500, json: async () => ({ ok: false }) }));
    await run.dispatch();
    assert.ok(run.buttons.every((button) => !button.disabled));
    assert.ok(run.fields.every((field) => !field.readOnly));
    await run.dispatch();
    assert.equal(run.calls.length, 2);
  }
});
