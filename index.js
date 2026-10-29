/**
 * Host half of @lixiangzhong/dsh-active-chat.
 *
 * The behaviour lives in the browser half (`./client`); this module only exists so
 * the bundle can be mounted as a normal Cordis plugin entry. It intentionally has no
 * telemetry: the workspace list is reordered locally through the documented
 * `IWorkspaces.insertBefore` client service.
 */
export function apply() {
  // Nothing to do on the Host side.
}
