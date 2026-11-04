# @lixiangzhong/dsh-active-chat

Pins **workspaces with in-progress sessions** to the top of the DSH sidebar, so you can
always see which chats are actually working.

The DSH sidebar keeps a single Host workspace order that only changes by dragging. This
plugin writes that order automatically whenever a workspace becomes active: its workspace
moves to the front, and the rest follow below in their previous relative order. When the
work finishes, the workspace sinks back below the still-active ones — it is not restored
to its old manual slot.

"In progress" is the same signal the sidebar's own activity dot uses: a session that is
running, or a session that is waiting for your reply (approval / plan review / question).

## Behaviour

- **Boot / first install** — aligns once. The workspace that became active most recently
  goes first; every other workspace keeps its current relative order. If the sidebar is
  already aligned, nothing is written.
- **New activation** — the workspace jumps to the top. If several workspaces are active,
  the most recently activated one is the highest.
- **Work finishes** — the workspace sinks below the workspaces that are still active.
- **Everything idle** — the plugin stops writing. Your manual drag order is preserved
  until the next activation.
- No settings and no UI: installing it turns it on; disable or uninstall the plugin to
  turn it off.

The order written by the plugin is the real Host workspace order (the same one a manual
drag produces), so it persists across reloads and other sessions.

## Install

Requires DSH >= 0.2.1-rc.2 with the Web profile. This is a regular DSH bundle and declares
no npm dependencies.

Install it from the DSH plugin manager UI, or from the CLI:

```sh
dsh plugin --profile web add @lixiangzhong/dsh-active-chat
```

To hack on the package from a local checkout, link that checkout instead:

```sh
dsh plugin --profile web add /path/to/dsh-active-chat
```

Then reload the page. To remove it, disable or uninstall the plugin and reload.

## How it works

`client.js` is a browser-side plugin. It injects the `workspaces`, `sessions` and
`uiSession` client services, subscribes to their snapshots, and calls the documented
`ctx.workspaces.insertBefore(workspaceId, beforeWorkspaceId?)` service to move a workspace
within the Host order. Changes are coalesced and only written when the set of active
workspaces actually changes. The Host half (`index.js`) is an empty plugin entry.

## Development

```sh
npm test    # syntax checks + behavioural tests (node:test, no browser needed)
```

The tests drive the plugin through fake snapshots; the behaviour they cover is the list
above.

## Releasing

Publishing runs in CI; this repository stores no npm token.

1. Bump the version and let npm write the release commit and tag: `npm version 0.1.1`
   (add `--no-git-tag-version` if you prefer to write the commit and tag yourself).
2. Push both: `git push origin master` and `git push origin v0.1.1`
   (or `git push --follow-tags`). The `v*` tag starts the release workflow.
3. [`.github/workflows/publish.yml`](.github/workflows/publish.yml) checks that the tag
   matches `package.json`, runs `npm test`, and publishes through
   [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC), which
   also attaches a provenance attestation.

Prerequisite: the npm package must list `.github/workflows/publish.yml` as a trusted
publisher (user `lixiangzhong`, repository `dsh-active-chat`) with **Allow npm publish**
enabled — new configurations default to stage-only publishing. A trusted-publisher
configuration expires unless its first successful publish happens within two days of
creation.

## License

MIT
