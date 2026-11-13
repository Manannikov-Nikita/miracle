# Project explorer file actions

The explorer should manage project files and folders through a right-click menu, using Miracle's existing compact Radix menus, Phosphor icons, colors and modal components. The user requested rename, move and delete, and chose deletion with confirmation while retaining unsaved editor drafts.

## Behavior

- Right-click a file/folder selects it without opening/toggling it. Show Rename, Move…, Delete…; folders and empty tree space also expose existing New file/New folder actions.
- Rename is inline in the tree row, without a modal, via the menu or F2. Focus the name field with the basename selected; Enter applies, Escape cancels. Keep the original extension in the value. Files and folders move with mouse drag/drop; the Move menu also provides an existing-folder picker with a project-root option.
- Reject name collisions, moves into the current folder or a folder's own descendants, internal paths, symlinks and protected contents. Show rename failures beside the input without losing the entered name; other operation failures remain in their dialog.
- Delete requires a dialog naming the file or folder and explicitly mentioning its contents for folders. Open documents remain as recoverable browser drafts; deleted files cannot be silently recreated by Save. Draft download remains available.
- Rename/move rebind every affected open document, retaining IDs, dirty contents and undo history. Cross-extension renames must retain current contents when moving between SQL and text editor modes.
- Menus support keyboard invocation, arrow navigation and Escape, fit within the viewport, and restore focus. Native menus outside the explorer and inside text fields remain available.
- Agent work and Git operations block conflicting filesystem mutations, including descendants of moved/deleted folders.

## Approach

Use the existing project file API and extend the move operation with an optional name; rename is a move within the same parent. Add a deletion endpoint. Use Radix Context Menu alongside existing Radix primitives rather than implementing focus/collision behavior manually. Keep editor coordination in SqlWorkspace, where existing move handling already preserves drafts. New folders and files reuse the existing creation flow.

Alternatives considered: a hand-built floating menu would duplicate keyboard/focus behavior; OS trash would need platform integration and was not the user's selected deletion behavior. No unrelated layout redesign, multiple selection, clipboard copy/paste, or remote file management.

## Verification

Node.js 24.22.2, meaningful filesystem/API and editor state tests, desktop browser checks only. Use synthetic test files, never user project files. Run the full suite and production build before reporting completion.
