/**
 * Browser half of @lixiangzhong/dsh-active-chat.
 *
 * Keeps Workspaces with in-progress sessions at the top of the DSH sidebar by writing
 * the real Host workspace order through the official `IWorkspaces.insertBefore` client
 * service. In-progress means the same signal the sidebar's own activity dot uses:
 * a session with `running: true` or a pending interaction.
 *
 * Ordering policy (confirmed with the user):
 *  - Boot / first install: align once; most recently active workspace first, then every
 *    other workspace in its current relative order.
 *  - After boot: reorder only when the active set changes. The newest activation goes
 *    to the top, an active workspace that finishes sinks below the still-active block.
 *  - When no workspace is active the user's own order is left untouched, and a manual
 *    drag is preserved until the next active-set change.
 */
window.__ModuleLoader__.load({
  id: '@lixiangzhong/dsh-active-chat',
  factory() {
    'use strict';

    /** Coalesce bursts of session/workspace invalidations into one ordering pass. */
    const EVALUATE_DEBOUNCE_MS = 40;
    /** Pause before retrying a pass that lost a race with another writer. */
    const RETRY_DELAY_MS = 300;
    /** Reorder passes are bounded so a pathological race can never spin forever. */
    const MAX_RECONCILE_ATTEMPTS = 3;
    /** Console prefix for diagnostics; the plugin never throws into the shell. */
    const LOG_PREFIX = '[dsh-active-chat]';

    function arraysEqual(left, right) {
      return left.length === right.length && left.every((value, index) => value === right[index]);
    }

    function wait(milliseconds) {
      return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
      });
    }

    /**
     * Whether one session counts as in progress for ordering purposes.
     * The live status map is authoritative; the session summary is the fallback while
     * that map has not observed the session yet. `running: undefined` means "not yet
     * known", which is treated as idle.
     */
    function sessionIsActive(status, summary) {
      if (status !== undefined && status.pendingInteraction !== undefined) return true;
      const running = status === undefined ? undefined : status.running;
      return running === undefined ? summary.running === true : running === true;
    }

    class ActiveWorkspaceOrder {
      constructor(ctx) {
        this.ctx = ctx;
        /** workspaceId -> activation rank; higher rank means more recently active. */
        this.ranks = new Map();
        this.nextRank = 1;
        /** Workspace ids that had an active session at the previous evaluation. */
        this.knownActive = new Set();
        this.bootAligned = false;
        this.timer = undefined;
        this.reconciling = false;
        this.reconcileQueued = false;
        this.disposed = false;
      }

      /** Subscribe to the three live sources and evaluate the current state once. */
      start() {
        const unsubscribers = [];
        try {
          const notify = () => this.schedule();
          unsubscribers.push(this.ctx.workspaces.list.subscribe(notify));
          unsubscribers.push(this.ctx.sessions.list.subscribe(notify));
          unsubscribers.push(this.ctx.uiSession.sessionStatus.subscribe(notify));
        } catch (error) {
          this.warn('failed to subscribe to workspace state', error);
          this.unsubscribeAll(unsubscribers);
          return () => {};
        }
        this.schedule();
        return () => {
          this.disposed = true;
          if (this.timer !== undefined) clearTimeout(this.timer);
          this.timer = undefined;
          this.unsubscribeAll(unsubscribers);
        };
      }

      unsubscribeAll(unsubscribers) {
        for (const unsubscribe of unsubscribers) {
          try {
            unsubscribe();
          } catch (error) {
            this.warn('unsubscribe failed', error);
          }
        }
      }

      schedule() {
        if (this.disposed || this.timer !== undefined) return;
        this.timer = setTimeout(() => {
          this.timer = undefined;
          try {
            this.evaluate();
          } catch (error) {
            this.warn('evaluation failed', error);
          }
        }, EVALUATE_DEBOUNCE_MS);
      }

      /**
       * Read the three snapshots together and derive the currently active workspaces.
       * Returns undefined until every source has delivered its baseline, so the plugin
       * neither writes against a half-loaded list nor pins with stale data.
       */
      readState() {
        const workspaces = this.ctx.workspaces.list.getSnapshot();
        if (workspaces.phase !== 'ready') return undefined;
        const sessions = this.ctx.sessions.list.getSnapshot();
        if (sessions.phase !== 'ready') return undefined;
        const statuses = this.ctx.uiSession.sessionStatus.getSnapshot();
        // The status map is published from the session baseline; an empty map while
        // sessions exist means it has not caught up yet.
        if (sessions.ids.length > 0 && statuses.size === 0) return undefined;

        const activeIds = new Set();
        const latestAt = new Map();
        for (const workspace of workspaces.items) {
          let active = false;
          let lastAt = 0;
          for (const sessionId of workspace.sessionIds) {
            const summary = sessions.byId[sessionId];
            if (summary === undefined) continue;
            if (!sessionIsActive(statuses.get(sessionId), summary)) continue;
            active = true;
            if (summary.updatedAt > lastAt) lastAt = summary.updatedAt;
          }
          if (active) {
            activeIds.add(workspace.workspaceId);
            latestAt.set(workspace.workspaceId, lastAt);
          }
        }
        return { order: workspaces.items.map((view) => view.workspaceId), activeIds, latestAt };
      }

      evaluate() {
        const state = this.readState();
        if (state === undefined) return;

        if (!this.bootAligned) {
          this.bootAligned = true;
          // Seed recency from durable session activity so the workspace that became
          // active last is the first one pinned when the page loads.
          const bootActive = state.order.filter((workspaceId) => state.activeIds.has(workspaceId));
          bootActive.sort(
            (left, right) => (state.latestAt.get(right) ?? 0) - (state.latestAt.get(left) ?? 0),
          );
          for (let index = bootActive.length - 1; index >= 0; index -= 1) {
            this.ranks.set(bootActive[index], this.nextRank);
            this.nextRank += 1;
          }
          this.knownActive = new Set(state.activeIds);
          this.requestReconcile();
          return;
        }

        let changed = false;
        for (const workspaceId of state.activeIds) {
          if (this.knownActive.has(workspaceId)) continue;
          this.ranks.set(workspaceId, this.nextRank);
          this.nextRank += 1;
          changed = true;
        }
        for (const workspaceId of this.knownActive) {
          if (state.activeIds.has(workspaceId)) continue;
          this.ranks.delete(workspaceId);
          changed = true;
        }
        this.knownActive = new Set(state.activeIds);
        if (changed) this.requestReconcile();
      }

      /** Serialize reorder passes: a running pass re-checks once more when nudged. */
      requestReconcile() {
        if (this.disposed) return;
        if (this.reconciling) {
          this.reconcileQueued = true;
          return;
        }
        this.reconciling = true;
        this.runReconcile()
          .catch((error) => this.warn('reorder failed', error))
          .finally(() => {
            this.reconciling = false;
            if (this.reconcileQueued && !this.disposed) {
              this.reconcileQueued = false;
              this.requestReconcile();
            }
          });
      }

      async runReconcile() {
        for (let attempt = 0; attempt < MAX_RECONCILE_ATTEMPTS; attempt += 1) {
          if (this.disposed) return;
          const outcome = await this.applyOnce();
          if (outcome !== 'retry') return;
          if (attempt < MAX_RECONCILE_ATTEMPTS - 1) await wait(RETRY_DELAY_MS);
        }
      }

      /**
       * Bring the Host order to the desired order with the minimum number of
       * insertBefore writes, walking left to right. Each awaited call re-reads the live
       * snapshot first; if another writer changed the order in between, it retries from
       * a fresh snapshot instead of fighting it.
       */
      async applyOnce() {
        const state = this.readState();
        if (state === undefined) return 'retry';
        const current = state.order;
        if (current.length === 0) return 'aligned';
        const desired = this.desiredOrder(current, state.activeIds);
        if (arraysEqual(current, desired)) return 'aligned';

        let model = current.slice();
        for (let index = 0; index < desired.length; index += 1) {
          const workspaceId = desired[index];
          if (model[index] === workspaceId) continue;
          const live = this.liveOrder();
          if (live === undefined || !arraysEqual(live, model)) return 'retry';
          const without = model.filter((id) => id !== workspaceId);
          const anchor = without[index];
          try {
            if (anchor === undefined) await this.ctx.workspaces.insertBefore(workspaceId);
            else await this.ctx.workspaces.insertBefore(workspaceId, anchor);
          } catch (error) {
            this.warn('insertBefore failed', workspaceId, error);
            return 'retry';
          }
          model = [...without.slice(0, index), workspaceId, ...without.slice(index)];
        }
        return 'applied';
      }

      /** Desired Host order: active workspaces by newest activation first, then the rest. */
      desiredOrder(current, activeIds) {
        const position = new Map(current.map((workspaceId, index) => [workspaceId, index]));
        const active = current.filter((workspaceId) => activeIds.has(workspaceId));
        active.sort((left, right) => {
          const byRank = (this.ranks.get(right) ?? 0) - (this.ranks.get(left) ?? 0);
          return byRank !== 0 ? byRank : position.get(left) - position.get(right);
        });
        const inactive = current.filter((workspaceId) => !activeIds.has(workspaceId));
        return [...active, ...inactive];
      }

      liveOrder() {
        const snapshot = this.ctx.workspaces.list.getSnapshot();
        if (snapshot.phase !== 'ready') return undefined;
        return snapshot.items.map((view) => view.workspaceId);
      }

      warn(...args) {
        console.warn(LOG_PREFIX, ...args);
      }
    }

    return {
      name: 'dsh-active-chat',
      inject: ['workspaces', 'sessions', 'uiSession'],
      apply(ctx) {
        try {
          const order = new ActiveWorkspaceOrder(ctx);
          if (typeof ctx.effect === 'function') ctx.effect(() => order.start());
          else order.start();
        } catch (error) {
          console.warn(LOG_PREFIX, 'failed to start', error);
        }
      },
    };
  },
});
