# Note Cards

Show notes on a canvas as compact title cards instead of full embedded documents.

## Features

- **Card view for notes.** Switch any markdown note on a canvas between the regular embedded view and a card: a small rectangle showing the note's name. If the note is narrowed to a heading, the card shows that heading.
- **Edit the title in place.** Use **Edit** in the selection toolbar or the right-click menu (or press Enter on a selected card) to rename the note right in the card. For a card narrowed to a heading, this renames the heading and updates links to it across the vault, like Obsidian's **Rename this heading**.
- **Edit the note in a modal.** Double-click a card, or use the **Preview** button that appears on hover, to open the note as an editable document in a modal.
- **Go to document.** The second hover button switches to the tab where the note is already open, or opens it in a new tab.
- **Create notes on the canvas.** A new toolbox button (click or drag) and an **Add note** item in the canvas right-click menu create a note and start editing it immediately. In card view you type the name into the card: Enter confirms, while Esc or an empty name discards the note.

## Usage

Select one or more notes on a canvas, then use any of:

- the card button in the floating menu above the selection,
- **Show as card** / **Show as note** in the right-click menu,
- the **Toggle card view for selected notes** command (assign a hotkey if you like).

Switching to card view shrinks the node to a compact size and remembers its previous size, which is restored when you switch back.

The chosen view is stored per node in the `.canvas` file. Without this plugin those nodes simply show as regular notes.

## Settings

- **Default note view** (Note / Card, default Note): the view used for notes newly added to a canvas. Notes already on a canvas are not affected.

### Where new notes are created

The create note button follows the core setting **Settings → Files and links → Default location for new notes**, the same one the built-in **Convert to file** uses. Set it to **Same folder as current file** to have notes created next to the canvas.

## Compatibility

Canvas has no official plugin API, so this plugin relies on undocumented Obsidian internals. An Obsidian update may break it; please open an issue if that happens.


## Development

```sh
npm install
npm run dev    # watch and rebuild main.js
npm run lint   # the rules the Obsidian community directory checks
npm run build  # typecheck and produce a minified main.js
```

To release, bump the version in `manifest.json` and `versions.json`, then push a tag equal to that version (no `v` prefix). The release workflow builds the plugin and creates a draft GitHub release with `main.js`, `manifest.json` and `styles.css` attached.

## License

[MIT](LICENSE)
