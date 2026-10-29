/**
 * Behavioural tests for the browser half of @lixiangzhong/dsh-active-chat.
 *
 * The plugin is loaded through the same `window.__ModuleLoader__` hook the DSH Web
 * shell provides, then driven by fake `workspaces` / `sessions` / `uiSession` services
 * so the real ordering policy is exercised without a browser.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const WORKSPACE_CREATED_AT = '2026-10-01T00:00:00.000Z';
const PLUGIN_ID = '@lixiangzhong/dsh-active-chat';
const WAIT_DEBOUNCE_MS = 120;

const loadedDefinitions = [];
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loadedDefinitions.push(definition);
    },
  },
};

await import(new URL('../client.js', import.meta.url));

function createPlugin() {
  const definition = loadedDefinitions[0];
  assert.equal(definition.id, PLUGIN_ID);
  return definition.factory(() => {
    throw new Error('the plugin must not require other client packages');
  });
}

function wait(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

class FakeEnvironment {
  /**
   * @param {object} options
   * @param {string[]} options.order Initial Host workspace order.
   * @param {Record<string, string[]>} options.workspaces Workspace id -> session ids.
   * @param {Record<string, {running?: boolean, updatedAt?: number}>} options.sessions
   * @param {Record<string, object>} [options.statuses] Explicit uiSession status map;
   *   omitted entirely, it is derived from `sessions` like the real shell does.
   */
  constructor({ order, workspaces, sessions, statuses }) {
    this.order = [...order];
    this.sessionIdsByWorkspace = workspaces;
    this.sessions = new Map(
      Object.entries(sessions).map(([sessionId, spec]) => [
        sessionId,
        {
          id: sessionId,
          displayTitle: sessionId,
          cwd: `/workspace/${spec.workspaceId}`,
          running: spec.running === true,
          blank: false,
          retainedBy: 'local',
          updatedAt: spec.updatedAt ?? 0,
        },
      ]),
    );
    this.statuses = new Map();
    if (statuses === undefined) {
      for (const [sessionId, summary] of this.sessions) {
        this.statuses.set(sessionId, { running: summary.running, completionUnread: false });
      }
    } else {
      for (const [sessionId, status] of Object.entries(statuses)) {
        this.statuses.set(sessionId, status);
      }
    }
    this.sessionPhase = 'ready';
    this.moves = [];
    this.listeners = { workspaces: new Set(), sessions: new Set(), statuses: new Set() };
    this.disposers = [];
  }

  workspaceSnapshot() {
    return {
      items: this.order.map((workspaceId) => ({
        workspaceId,
        path: `/workspace/${workspaceId}`,
        title: workspaceId,
        sessionIds: [...(this.sessionIdsByWorkspace[workspaceId] ?? [])],
        createdAt: WORKSPACE_CREATED_AT,
        updatedAt: WORKSPACE_CREATED_AT,
      })),
      archivedSessionIds: [],
      pinnedSessionIds: [],
      state: 'idle',
      phase: 'ready',
      error: null,
    };
  }

  sessionSnapshot() {
    const ids = [];
    const byId = {};
    for (const [sessionId, summary] of this.sessions) {
      ids.push(sessionId);
      byId[sessionId] = summary;
    }
    return { ids, byId, phase: this.sessionPhase, projectionsBySession: {} };
  }

  statusesSnapshot() {
    return this.statuses;
  }

  subscribe(kind, listener) {
    this.listeners[kind].add(listener);
    return () => {
      this.listeners[kind].delete(listener);
    };
  }

  emit(kind) {
    for (const listener of [...this.listeners[kind]]) listener();
  }

  async insertBefore(workspaceId, beforeWorkspaceId) {
    this.moves.push([workspaceId, beforeWorkspaceId]);
    const without = this.order.filter((id) => id !== workspaceId);
    const index =
      beforeWorkspaceId === undefined ? without.length : without.indexOf(beforeWorkspaceId);
    if (index < 0) throw new Error(`unknown anchor ${beforeWorkspaceId}`);
    without.splice(index, 0, workspaceId);
    this.order = without;
    this.emit('workspaces');
  }

  /** Simulate any other writer (a manual drag) changing the Host order. */
  drag(workspaceId, beforeWorkspaceId) {
    const without = this.order.filter((id) => id !== workspaceId);
    const index = without.indexOf(beforeWorkspaceId);
    without.splice(index < 0 ? without.length : index, 0, workspaceId);
    this.order = without;
    this.emit('workspaces');
  }

  activate(sessionId) {
    this.sessions.get(sessionId).running = true;
    this.statuses.set(sessionId, { running: true, completionUnread: false });
    this.emit('statuses');
  }

  deactivate(sessionId) {
    this.sessions.get(sessionId).running = false;
    this.statuses.set(sessionId, { running: false, completionUnread: false });
    this.emit('statuses');
  }

  completeSessionBaseline() {
    this.sessionPhase = 'ready';
    this.emit('sessions');
  }

  start(plugin) {
    const ctx = {
      workspaces: {
        list: {
          getSnapshot: () => this.workspaceSnapshot(),
          subscribe: (listener) => this.subscribe('workspaces', listener),
        },
        insertBefore: (workspaceId, beforeWorkspaceId) =>
          this.insertBefore(workspaceId, beforeWorkspaceId),
      },
      sessions: {
        list: {
          getSnapshot: () => this.sessionSnapshot(),
          subscribe: (listener) => this.subscribe('sessions', listener),
        },
      },
      uiSession: {
        sessionStatus: {
          getSnapshot: () => this.statusesSnapshot(),
          subscribe: (listener) => this.subscribe('statuses', listener),
        },
      },
      effect: (execute) => {
        const dispose = execute();
        this.disposers.push(typeof dispose === 'function' ? dispose : () => {});
        return () => {};
      },
    };
    plugin.apply(ctx);
  }

  dispose() {
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // Test teardown only.
      }
    }
  }
}

function singleSessionWorkspaces(workspaceIds) {
  const workspaces = {};
  const sessions = {};
  for (const workspaceId of workspaceIds) {
    const sessionId = `session-${workspaceId}`;
    workspaces[workspaceId] = [sessionId];
    sessions[sessionId] = { workspaceId };
  }
  return { workspaces, sessions };
}

async function run(options, scenario) {
  const environment = new FakeEnvironment(options);
  try {
    environment.start(createPlugin());
    await scenario(environment);
  } finally {
    environment.dispose();
  }
}

test('boot alignment pins the most recently active workspace first', async () => {
  const base = singleSessionWorkspaces(['w1', 'w2', 'w3']);
  await run(
    {
      order: ['w1', 'w2', 'w3'],
      workspaces: base.workspaces,
      sessions: {
        ...base.sessions,
        'session-w3': { workspaceId: 'w3', running: true, updatedAt: 500 },
      },
    },
    async (environment) => {
      await wait(WAIT_DEBOUNCE_MS);
      assert.deepEqual(environment.order, ['w3', 'w1', 'w2']);
      assert.ok(environment.moves.length > 0);
    },
  );
});

test('boot alignment writes nothing when the order is already aligned', async () => {
  const base = singleSessionWorkspaces(['w1', 'w2']);
  await run(
    {
      order: ['w1', 'w2'],
      workspaces: base.workspaces,
      sessions: { ...base.sessions, 'session-w1': { workspaceId: 'w1', running: true } },
    },
    async (environment) => {
      await wait(WAIT_DEBOUNCE_MS);
      assert.deepEqual(environment.order, ['w1', 'w2']);
      assert.deepEqual(environment.moves, []);
    },
  );
});

test('several active workspaces are ordered by most recent activity', async () => {
  const base = singleSessionWorkspaces(['w1', 'w2', 'w3']);
  await run(
    {
      order: ['w1', 'w2', 'w3'],
      workspaces: base.workspaces,
      sessions: {
        ...base.sessions,
        'session-w1': { workspaceId: 'w1', running: true, updatedAt: 100 },
        'session-w2': { workspaceId: 'w2', running: true, updatedAt: 300 },
      },
    },
    async (environment) => {
      await wait(WAIT_DEBOUNCE_MS);
      assert.deepEqual(environment.order, ['w2', 'w1', 'w3']);
    },
  );
});

test('a newly activated workspace jumps to the top', async () => {
  const base = singleSessionWorkspaces(['w1', 'w2', 'w3']);
  await run(
    { order: ['w1', 'w2', 'w3'], workspaces: base.workspaces, sessions: base.sessions },
    async (environment) => {
      await wait(WAIT_DEBOUNCE_MS);
      assert.deepEqual(environment.order, ['w1', 'w2', 'w3']);
      assert.deepEqual(environment.moves, []);

      environment.activate('session-w3');
      await wait(WAIT_DEBOUNCE_MS);
      assert.deepEqual(environment.order, ['w3', 'w1', 'w2']);

      environment.activate('session-w1');
      await wait(WAIT_DEBOUNCE_MS);
      assert.deepEqual(environment.order, ['w1', 'w3', 'w2']);
    },
  );
});

test('a finished workspace sinks below the still-active ones', async () => {
  const base = singleSessionWorkspaces(['w1', 'w2', 'w3']);
  await run(
    {
      order: ['w1', 'w2', 'w3'],
      workspaces: base.workspaces,
      sessions: { ...base.sessions, 'session-w1': { workspaceId: 'w1', running: true } },
    },
    async (environment) => {
      await wait(WAIT_DEBOUNCE_MS);
      assert.deepEqual(environment.order, ['w1', 'w2', 'w3']);

      environment.activate('session-w2');
      await wait(WAIT_DEBOUNCE_MS);
      assert.deepEqual(environment.order, ['w2', 'w1', 'w3']);

      environment.deactivate('session-w2');
      await wait(WAIT_DEBOUNCE_MS);
      assert.deepEqual(environment.order, ['w1', 'w2', 'w3']);
    },
  );
});

test('a session waiting for your reply counts as active', async () => {
  await run(
    {
      order: ['w1', 'w2'],
      workspaces: { w1: ['s1'], w2: ['s2'] },
      sessions: {
        s1: { workspaceId: 'w1', running: false },
        s2: { workspaceId: 'w2', running: false },
      },
      statuses: {
        s2: { running: false, pendingInteraction: { kind: 'approval' }, completionUnread: false },
      },
    },
    async (environment) => {
      await wait(WAIT_DEBOUNCE_MS);
      assert.deepEqual(environment.order, ['w2', 'w1']);
    },
  );
});

test('a completion reminder alone does not pin a workspace', async () => {
  await run(
    {
      order: ['w1', 'w2'],
      workspaces: { w1: ['s1'], w2: ['s2'] },
      sessions: {
        s1: { workspaceId: 'w1', running: false },
        s2: { workspaceId: 'w2', running: false },
      },
      statuses: {
        s2: { running: false, completionUnread: true },
      },
    },
    async (environment) => {
      await wait(WAIT_DEBOUNCE_MS);
      assert.deepEqual(environment.order, ['w1', 'w2']);
      assert.deepEqual(environment.moves, []);
    },
  );
});

test('a manual drag is preserved until the next activation', async () => {
  const base = singleSessionWorkspaces(['w1', 'w2', 'w3']);
  await run(
    { order: ['w1', 'w2', 'w3'], workspaces: base.workspaces, sessions: base.sessions },
    async (environment) => {
      await wait(WAIT_DEBOUNCE_MS);
      assert.deepEqual(environment.moves, []);

      environment.drag('w3', 'w1');
      await wait(WAIT_DEBOUNCE_MS);
      assert.deepEqual(environment.order, ['w3', 'w1', 'w2']);
      assert.deepEqual(environment.moves, []);

      environment.activate('session-w2');
      await wait(WAIT_DEBOUNCE_MS);
      assert.deepEqual(environment.order, ['w2', 'w3', 'w1']);
    },
  );
});

test('waits for the session baseline before aligning', async () => {
  const base = singleSessionWorkspaces(['w1', 'w2']);
  const environment = new FakeEnvironment({
    order: ['w1', 'w2'],
    workspaces: base.workspaces,
    sessions: { ...base.sessions, 'session-w2': { workspaceId: 'w2', running: true } },
  });
  try {
    environment.sessionPhase = 'pending';
    environment.start(createPlugin());
    await wait(WAIT_DEBOUNCE_MS);
    assert.deepEqual(environment.moves, []);

    environment.completeSessionBaseline();
    await wait(WAIT_DEBOUNCE_MS);
    assert.deepEqual(environment.order, ['w2', 'w1']);
  } finally {
    environment.dispose();
  }
});

test('falls back to the session summary when the status map has not seen it', async () => {
  await run(
    {
      order: ['w2', 'w1'],
      workspaces: { w1: ['s1'], w2: ['s2'] },
      sessions: {
        s1: { workspaceId: 'w1', running: true, updatedAt: 50 },
        s2: { workspaceId: 'w2', running: false, updatedAt: 10 },
      },
      statuses: { s2: { running: false, completionUnread: false } },
    },
    async (environment) => {
      await wait(WAIT_DEBOUNCE_MS);
      assert.deepEqual(environment.order, ['w1', 'w2']);
    },
  );
});
