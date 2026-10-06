import { around } from "monkey-around";
import {
	App,
	Component,
	EventRef,
	ItemView,
	MarkdownFileInfo,
	Menu,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	SettingDefinitionItem,
	TFile,
	WorkspaceLeaf,
	normalizePath,
	parseLinktext,
	resolveSubpath,
	setIcon,
	setTooltip,
	stripHeading,
	stripHeadingForLink,
} from "obsidian";

type NodeView = "note" | "card";

interface NoteCardsSettings {
	defaultView: NodeView;
}

const DEFAULT_SETTINGS: NoteCardsSettings = { defaultView: "note" };

// Keys stored on the node inside the .canvas file (Obsidian keeps unknown keys).
const VIEW_KEY = "noteCardView";
const PREV_SIZE_KEY = "noteCardPrevSize";

const CARD_SIZE: Size = { width: 250, height: 60 };

// Minimal typings for the undocumented canvas internals this plugin touches.
interface Size {
	width: number;
	height: number;
}
interface Pos {
	x: number;
	y: number;
}
interface CanvasNode {
	canvas: Canvas;
	nodeEl: HTMLElement;
	containerEl?: HTMLElement;
	width: number;
	height: number;
	unknownData: Record<string, unknown>;
	resize(size: Size): void;
	attach(): void;
	render(): void;
	setData(data: unknown): void;
	setIsEditing(editing: boolean): void;
	startEditing(...args: unknown[]): void;
	// file nodes only
	isEditing?: boolean;
	file?: TFile | null;
	filePath?: string;
	subpath?: string;
	child?: Partial<MarkdownEmbed> | null;
	setFilePath?(path: string, subpath: string): void;
}
/** The editable note widget canvas itself embeds into file nodes. */
interface MarkdownEmbed extends Component {
	editable: boolean;
	loadFile(): Promise<void>;
	showEditor(): void;
	showPreview(save?: boolean): void;
	focusTitle(): void;
}
interface CanvasWorkspaceEvents {
	on(name: "canvas:node-menu", callback: (menu: Menu, node: CanvasNode) => void): EventRef;
	on(name: "canvas:selection-menu", callback: (menu: Menu, canvas: Canvas) => void): EventRef;
}
interface SubpathUpdater {
	renameSubpath?(file: TFile, oldSubpath: string, newSubpath: string): Promise<void>;
}
type EmbedCreator = (
	ctx: { app: App; linktext: string; sourcePath: string; containerEl: HTMLElement; depth: number },
	file: TFile,
	subpath: string,
) => MarkdownEmbed;
interface CanvasMenu {
	canvas: Canvas;
	menuEl: HTMLElement;
	render(force?: boolean): void;
}
interface Canvas {
	view: { file: TFile | null };
	nodes: Map<string, CanvasNode>;
	selection: Set<CanvasNode>;
	readonly: boolean;
	cardMenuEl?: HTMLElement;
	menu: CanvasMenu;
	config: { defaultFileNodeDimensions: Size };
	posCenter(): Pos;
	createFileNode(opts: { pos: Pos; size?: Size; position?: string; file: TFile; save?: boolean }): CanvasNode;
	dragTempNode(evt: PointerEvent, size: Size, onDrop: (pos: Pos) => void): void;
	showCreationMenu(menu: Menu, pos: Pos, size?: Size): void;
	addNode(node: CanvasNode): void;
	removeNode(node: CanvasNode): void;
	selectOnly(node: CanvasNode): void;
	requestSave(): void;
}

function isNoteNode(node: CanvasNode): boolean {
	return node.filePath !== undefined && node.file?.extension === "md";
}

/** "#Heading" or "#Parent#Child", but not a block reference ("#^id"). */
function isHeadingSubpath(subpath: string | undefined): subpath is string {
	return !!subpath && subpath.startsWith("#") && !subpath.startsWith("#^");
}

function cardTitle(node: CanvasNode): string {
	if (isHeadingSubpath(node.subpath)) {
		const heading = node.subpath.split("#").pop();
		if (heading) return heading;
	}
	return node.file?.basename ?? node.filePath ?? "";
}

interface TextEdit {
	start: number;
	end: number;
	/** Gets the text currently in the range; null leaves it untouched. */
	replace(current: string): string | null;
}

function applyEdits(data: string, edits: TextEdit[]): string {
	// back to front, so earlier offsets stay valid
	for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
		const text = edit.replace(data.slice(edit.start, edit.end));
		if (text !== null) data = data.slice(0, edit.start) + text + data.slice(edit.end);
	}
	return data;
}

/** Swaps the target inside a link's source text, keeping its style (wikilink/markdown, alias, embed). */
function rewriteLink(original: string, link: string, newLink: string): string | null {
	// markdown links carry the target URL-encoded
	const encodings = [(text: string) => text, encodeURI, (text: string) => text.replace(/ /g, "%20")];
	for (const encode of encodings) {
		const from = encode(link);
		if (original.includes(from)) return original.replace(from, () => encode(newLink));
	}
	return null;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export default class NoteCardsPlugin extends Plugin {
	settings: NoteCardsSettings = DEFAULT_SETTINGS;
	private canvasPatched = false;
	// true while the canvas is creating a brand new file node (as opposed to loading one)
	private creatingNode = false;
	private nodePatched = false;

	async onload() {
		const saved = (await this.loadData()) as Partial<NoteCardsSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...saved };
		this.addSettingTab(new NoteCardsSettingTab(this.app, this));

		this.addCommand({
			id: "toggle-card-view",
			name: "Toggle card view for selected notes",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(ItemView);
				const canvas = view?.getViewType() === "canvas" ? (view as unknown as { canvas: Canvas }).canvas : null;
				const notes = canvas && !canvas.readonly ? this.selectedNotes(canvas) : [];
				if (!notes.length) return false;
				if (!checking) this.toggle(notes);
				return true;
			},
		});

		// canvas events are not part of the public Workspace typings
		const workspace = this.app.workspace as unknown as CanvasWorkspaceEvents;
		this.registerEvent(
			workspace.on("canvas:node-menu", (menu: Menu, node: CanvasNode) => {
				if (!node.canvas.readonly && isNoteNode(node)) this.addMenuItem(menu, [node]);
			}),
		);
		this.registerEvent(
			workspace.on("canvas:selection-menu", (menu: Menu, canvas: Canvas) => {
				const notes = this.selectedNotes(canvas);
				if (!canvas.readonly && notes.length) this.addMenuItem(menu, notes);
			}),
		);

		// canvas does not re-render a node when its file is renamed, so card titles would go stale
		this.registerEvent(this.app.vault.on("rename", () => this.refreshAll()));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.setupCanvases()));
		this.app.workspace.onLayoutReady(() => this.setupCanvases());
	}

	onunload() {
		for (const canvas of this.canvases()) {
			canvas.cardMenuEl?.querySelector(".note-card-create")?.remove();
			canvas.menu.menuEl.querySelector(".note-card-toggle")?.remove();
			for (const node of canvas.nodes.values()) {
				node.nodeEl.removeClass("is-note-card");
				node.nodeEl.querySelector(".note-card")?.remove();
			}
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private canvases(): Canvas[] {
		return this.app.workspace
			.getLeavesOfType("canvas")
			.map((leaf) => (leaf.view as unknown as { canvas?: Canvas }).canvas)
			.filter((canvas): canvas is Canvas => !!canvas);
	}

	private setupCanvases() {
		for (const canvas of this.canvases()) {
			this.patchCanvas(canvas);
			this.addToolboxButton(canvas);
			for (const node of canvas.nodes.values()) this.patchNode(node);
		}
	}

	private refreshAll() {
		for (const canvas of this.canvases()) {
			for (const node of canvas.nodes.values()) this.syncNode(node);
		}
	}

	// --- patches -----------------------------------------------------------

	private patchCanvas(canvas: Canvas) {
		if (this.canvasPatched) return;
		this.canvasPatched = true;
		// eslint-disable-next-line @typescript-eslint/no-this-alias -- patched methods are called with the canvas object as "this"
		const plugin = this;

		this.register(
			around(Object.getPrototypeOf(canvas) as Canvas, {
				createFileNode(next) {
					return function (this: Canvas, opts) {
						plugin.creatingNode = true;
						try {
							return next.call(this, opts);
						} finally {
							plugin.creatingNode = false;
						}
					};
				},
				addNode(next) {
					return function (this: Canvas, node: CanvasNode) {
						// before next: createFileNode saves right after adding the node
						if (plugin.creatingNode) plugin.applyDefaultView(node);
						next.call(this, node);
						plugin.patchNode(node);
					};
				},
				// right-click menu on empty canvas space
				showCreationMenu(next) {
					return function (this: Canvas, menu: Menu, pos: Pos, size?: Size) {
						next.call(this, menu, pos, size);
						menu.addItem((item) =>
							item
								.setSection("create")
								.setTitle("Add note")
								.setIcon("file-plus")
								.onClick(() => void plugin.addNewNote(this, pos, false)),
						);
					};
				},
			}),
		);
		this.register(
			around(Object.getPrototypeOf(canvas.menu) as CanvasMenu, {
				render(next) {
					return function (this: CanvasMenu, force?: boolean) {
						next.call(this, force);
						plugin.addPopupButton(this);
					};
				},
			}),
		);
	}

	/** Patches the file node class the first time we see an instance of it. */
	private patchNode(node: CanvasNode) {
		if (this.nodePatched || node.filePath === undefined) return;
		this.nodePatched = true;
		// eslint-disable-next-line @typescript-eslint/no-this-alias -- patched methods are called with the canvas object as "this"
		const plugin = this;

		this.register(
			around(Object.getPrototypeOf(node) as CanvasNode, {
				render(next) {
					return function (this: CanvasNode) {
						next.call(this);
						plugin.syncNode(this);
					};
				},
				// covers undo/redo, which may change only our keys and skip render
				setData(next) {
					return function (this: CanvasNode, data: unknown) {
						next.call(this, data);
						plugin.syncNode(this);
					};
				},
				// "Edit" in the selection toolbar / context menu, Enter key
				startEditing(next) {
					return function (this: CanvasNode, ...args: unknown[]) {
						if (plugin.isCard(this)) plugin.editCardTitle(this);
						else next.apply(this, args);
					};
				},
			}),
		);
		this.refreshAll();
	}

	// --- card view ---------------------------------------------------------

	private viewOf(node: CanvasNode): NodeView {
		return node.unknownData[VIEW_KEY] === "card" ? "card" : "note";
	}

	/** The default view only applies to nodes created from now on, never to existing ones. */
	private applyDefaultView(node: CanvasNode) {
		if (this.settings.defaultView !== "card" || !isNoteNode(node)) return;
		const full = node.canvas.config.defaultFileNodeDimensions;
		if (node.width === full.width && node.height === full.height) {
			this.setView(node, "card");
			return;
		}
		node.unknownData[VIEW_KEY] = "card";
		if (node.width === CARD_SIZE.width && node.height === CARD_SIZE.height) {
			// created at card size - give it a sensible size to grow into as a note
			node.unknownData[PREV_SIZE_KEY] = { ...full };
		}
	}

	private isCard(node: CanvasNode): boolean {
		return isNoteNode(node) && this.viewOf(node) === "card";
	}

	private syncNode(node: CanvasNode) {
		const container = node.containerEl;
		if (!container) return; // not initialized yet, render() will get back to us
		const isCard = this.isCard(node);
		node.nodeEl.toggleClass("is-note-card", isCard);

		let cardEl = container.querySelector<HTMLElement>(":scope > .note-card");
		if (!isCard) {
			cardEl?.remove();
			return;
		}
		cardEl ??= this.buildCard(node, container);
		const titleEl = cardEl.querySelector<HTMLElement>(".note-card-title");
		if (titleEl && !titleEl.isContentEditable) titleEl.setText(cardTitle(node));
	}

	private buildCard(node: CanvasNode, container: HTMLElement): HTMLElement {
		const cardEl = container.createDiv("note-card");
		cardEl.createDiv("note-card-title");
		cardEl.addEventListener("dblclick", (evt) => {
			// the node would otherwise start editing the (hidden) embedded note
			evt.preventDefault();
			if (node.file && !node.isEditing) new NoteModal(this.app, node.file, node.subpath ?? "").open();
		});

		const actions = cardEl.createDiv("note-card-actions");
		const addAction = (icon: string, label: string, onClick: (file: TFile) => void) => {
			const button = actions.createDiv("clickable-icon");
			setIcon(button, icon);
			setTooltip(button, label, { placement: "top" });
			// keep the canvas from starting a drag / changing selection
			button.addEventListener("pointerdown", (evt) => evt.stopPropagation());
			button.addEventListener("dblclick", (evt) => evt.stopPropagation());
			button.addEventListener("click", (evt) => {
				evt.stopPropagation();
				if (node.file) onClick(node.file);
			});
		};
		addAction("eye", "Preview", (file) => new NoteModal(this.app, file, node.subpath ?? "").open());
		addAction("file-symlink", "Go to document", (file) => void this.goToDocument(file, node.subpath ?? ""));
		return cardEl;
	}

	private async goToDocument(file: TFile, subpath: string) {
		let leaf: WorkspaceLeaf | null = null;
		this.app.workspace.iterateAllLeaves((candidate) => {
			const state = candidate.getViewState();
			if (!leaf && state.type === "markdown" && state.state?.file === file.path) leaf = candidate;
		});
		leaf ??= this.app.workspace.getLeaf("tab");
		await leaf.openFile(file, { active: true, eState: subpath ? { subpath } : undefined });
		await this.app.workspace.revealLeaf(leaf);
	}

	// --- editing the card title --------------------------------------------

	/**
	 * Turns the card title into an inline text field. Enter or clicking away
	 * commits, Esc cancels; an empty entry counts as cancel.
	 */
	private startTitleEdit(node: CanvasNode, initial: string, onCommit: (text: string) => void, onCancel?: () => void) {
		const titleEl = node.containerEl?.querySelector<HTMLElement>(":scope > .note-card > .note-card-title");
		if (!titleEl || titleEl.isContentEditable) return;

		node.canvas.selectOnly(node);
		node.setIsEditing(true);
		titleEl.setText(initial);
		titleEl.contentEditable = "plaintext-only";
		titleEl.focus();
		titleEl.win.getSelection()?.selectAllChildren(titleEl);

		const listeners = new AbortController();
		const finish = (commit: boolean) => {
			if (listeners.signal.aborted) return;
			listeners.abort();
			const text = titleEl.getText().replace(/\s+/g, " ").trim();
			titleEl.contentEditable = "false";
			titleEl.blur();
			node.setIsEditing(false);
			this.syncNode(node);
			if (commit && text) onCommit(text);
			else onCancel?.();
		};
		const on = <K extends keyof HTMLElementEventMap>(type: K, handler: (evt: HTMLElementEventMap[K]) => void) =>
			titleEl.addEventListener(type, handler, { signal: listeners.signal });

		on("keydown", (evt) => {
			if (evt.isComposing) return;
			if (evt.key === "Enter" || evt.key === "Escape") {
				evt.preventDefault();
				evt.stopPropagation();
				finish(evt.key === "Enter");
			}
		});
		on("blur", () => finish(true));
		// let the mouse place the caret instead of dragging the node or opening the modal
		on("pointerdown", (evt) => evt.stopPropagation());
		on("dblclick", (evt) => evt.stopPropagation());
	}

	/** Renames what the card shows: the heading it is narrowed to, otherwise the file. */
	private editCardTitle(node: CanvasNode) {
		const file = node.file;
		if (!file || node.canvas.readonly) return;
		if (isHeadingSubpath(node.subpath)) {
			const heading = this.resolveHeading(file, node.subpath);
			this.startTitleEdit(node, heading?.heading ?? cardTitle(node), (text) => void this.renameHeading(node, file, text));
		} else {
			this.startTitleEdit(node, file.basename, (text) => void this.renameFile(file, text));
		}
	}

	private async renameFile(file: TFile, name: string) {
		if (name === file.basename) return;
		const folder = file.parent && !file.parent.isRoot() ? `${file.parent.path}/` : "";
		const path = normalizePath(`${folder}${name}.${file.extension}`);
		if (this.app.vault.getAbstractFileByPath(path)) {
			new Notice(`"${name}" already exists.`);
			return;
		}
		try {
			await this.app.fileManager.renameFile(file, path);
		} catch (err) {
			new Notice(`Could not rename note: ${errorMessage(err)}`);
		}
	}

	/** Notes with at least one link to the file, plus the file itself (for "[[#Heading]]" links). */
	private filesLinkingTo(file: TFile): TFile[] {
		const sources = new Set<TFile>([file]);
		for (const [sourcePath, targets] of Object.entries(this.app.metadataCache.resolvedLinks)) {
			if (!(file.path in targets)) continue;
			const source = this.app.vault.getAbstractFileByPath(sourcePath);
			if (source instanceof TFile) sources.add(source);
		}
		return [...sources];
	}

	private resolveHeading(file: TFile, subpath: string) {
		const cache = this.app.metadataCache.getFileCache(file);
		const result = cache ? resolveSubpath(cache, subpath) : null;
		return result?.type === "heading" ? result.current : null;
	}

	/**
	 * Same effect as Obsidian's "Rename this heading": rewrites the heading in the note,
	 * every link to it across the vault, and canvas cards narrowed to it.
	 */
	private async renameHeading(node: CanvasNode, file: TFile, text: string) {
		const { vault, metadataCache } = this.app;
		const oldSubpath = node.subpath ?? "";
		const heading = this.resolveHeading(file, oldSubpath);
		if (!heading) {
			new Notice("Could not find the heading in the note.");
			return;
		}
		if (heading.heading === text) return;
		// Obsidian matches heading links on this normalized form
		const oldKey = stripHeading(heading.heading).toLowerCase();
		const newLink = stripHeadingForLink(text);
		const pointsAtHeading = (subpath: string | undefined) =>
			isHeadingSubpath(subpath) && stripHeading(subpath.substring(1)).toLowerCase() === oldKey;

		// links to the heading, per source file
		const edits = new Map<TFile, TextEdit[]>();
		let linkCount = 0;
		for (const source of this.filesLinkingTo(file)) {
			const cache = metadataCache.getFileCache(source);
			for (const ref of [...(cache?.links ?? []), ...(cache?.embeds ?? [])]) {
				const { path, subpath } = parseLinktext(ref.link);
				if (!pointsAtHeading(subpath)) continue;
				const target = path ? metadataCache.getFirstLinkpathDest(path, source.path) : source;
				if (target !== file) continue;
				const updated = rewriteLink(ref.original, ref.link, `${path}#${newLink}`);
				if (!updated) continue;
				const list = edits.get(source) ?? [];
				list.push({
					start: ref.position.start.offset,
					end: ref.position.end.offset,
					// skip if the file changed under a stale cache
					replace: (current) => (current === ref.original ? updated : null),
				});
				edits.set(source, list);
				linkCount++;
			}
		}

		// the heading itself goes first, together with the links inside the same note
		let renamed = false;
		const headingEdit: TextEdit = {
			start: heading.position.start.offset,
			end: heading.position.end.offset,
			replace: (current) => {
				const match = /^(\s*#{1,6}\s+)/.exec(current);
				renamed = !!match;
				return match ? match[1] + text : null;
			},
		};
		const ownEdits = [headingEdit, ...(edits.get(file) ?? [])];
		edits.delete(file);
		await vault.process(file, (data) => {
			const result = applyEdits(data, ownEdits);
			return renamed ? result : data;
		});
		if (!renamed) {
			new Notice("Could not rename the heading.");
			return;
		}
		for (const [source, list] of edits) {
			await vault.process(source, (data) => applyEdits(data, list));
		}

		// open canvases are updated in memory, so unsaved changes in them are not lost...
		const parts = oldSubpath.split("#");
		parts[parts.length - 1] = newLink;
		const nestedSubpath = parts.join("#");
		for (const canvas of this.canvases()) {
			let changed = false;
			for (const other of canvas.nodes.values()) {
				if (other.file !== file || !other.filePath) continue;
				const next = other.subpath === oldSubpath ? nestedSubpath : pointsAtHeading(other.subpath) ? `#${newLink}` : null;
				if (next === null) continue;
				other.setFilePath?.(other.filePath, next);
				changed = true;
			}
			if (changed) canvas.requestSave();
		}
		// ...and Obsidian's own canvas link updater takes care of the canvas files on disk
		const updaters = (metadataCache as unknown as { linkUpdaters?: Record<string, SubpathUpdater> }).linkUpdaters ?? {};
		for (const updater of Object.values(updaters)) {
			try {
				await updater.renameSubpath?.(file, oldKey, newLink);
			} catch (err) {
				console.error("Note Cards: could not update canvas files", err);
			}
		}

		if (linkCount) new Notice(`Updated ${linkCount} link${linkCount === 1 ? "" : "s"} to the heading.`);
	}

	// --- switching views ---------------------------------------------------

	private selectedNotes(canvas: Canvas): CanvasNode[] {
		return Array.from(canvas.selection).filter(isNoteNode);
	}

	/** Cards become notes only when every given node is already a card. */
	private toggle(nodes: CanvasNode[]) {
		const view: NodeView = nodes.every((node) => this.viewOf(node) === "card") ? "note" : "card";
		for (const node of nodes) this.setView(node, view);
		nodes[0]?.canvas.requestSave();
	}

	private setView(node: CanvasNode, view: NodeView) {
		if (this.viewOf(node) !== view) {
			if (view === "card") {
				node.unknownData[PREV_SIZE_KEY] = { width: node.width, height: node.height };
				node.resize(CARD_SIZE);
			} else {
				const prev = node.unknownData[PREV_SIZE_KEY] as Size | undefined;
				delete node.unknownData[PREV_SIZE_KEY];
				if (prev?.width && prev?.height) node.resize({ width: prev.width, height: prev.height });
			}
		}
		node.unknownData[VIEW_KEY] = view;
		this.syncNode(node);
	}

	private addMenuItem(menu: Menu, nodes: CanvasNode[]) {
		const allCards = nodes.every((node) => this.viewOf(node) === "card");
		menu.addItem((item) =>
			item
				.setSection("canvas")
				.setTitle(allCards ? "Show as note" : "Show as card")
				.setIcon(allCards ? "file-text" : "rectangle-horizontal")
				.onClick(() => this.toggle(nodes)),
		);
	}

	/** Button in the floating menu above the selection. */
	private addPopupButton(menu: CanvasMenu) {
		const canvas = menu.canvas;
		const existing = menu.menuEl.querySelector(".note-card-toggle");
		if (canvas.readonly || !this.selectedNotes(canvas).length) {
			existing?.remove();
			return;
		}
		if (existing || !menu.menuEl.childElementCount) return;
		const button = menu.menuEl.createEl("button", { cls: "clickable-icon note-card-toggle" });
		setIcon(button, "rectangle-horizontal");
		setTooltip(button, "Toggle card view", { placement: "top" });
		button.addEventListener("click", () => this.toggle(this.selectedNotes(canvas)));
	}

	// --- creating notes ----------------------------------------------------

	private addToolboxButton(canvas: Canvas) {
		const toolbox = canvas.cardMenuEl;
		if (!toolbox || toolbox.querySelector(".note-card-create")) return;
		const button = toolbox.createDiv("canvas-card-menu-button mod-draggable note-card-create");
		setIcon(button, "file-plus");
		setTooltip(button, "Drag to add new note", { placement: "top" });
		button.addEventListener("click", () => void this.addNewNote(canvas, canvas.posCenter(), true));
		button.addEventListener("pointerdown", (evt) =>
			canvas.dragTempNode(evt, this.newNodeSize(canvas), (pos) => void this.addNewNote(canvas, pos, false)),
		);
	}

	private newNodeSize(canvas: Canvas): Size {
		return this.settings.defaultView === "card" ? CARD_SIZE : canvas.config.defaultFileNodeDimensions;
	}

	/**
	 * Creates an "Untitled" note on the canvas and starts editing it right away.
	 * Card view: the title is edited in the card, and leaving it empty (or Esc) drops the note again.
	 * Note view: the embedded editor opens, as if the node was double-clicked.
	 */
	private async addNewNote(canvas: Canvas, pos: Pos, centered: boolean) {
		if (canvas.readonly) return;
		let file: TFile;
		try {
			file = await this.createNote(canvas, "Untitled");
		} catch (err) {
			new Notice(`Could not create note: ${errorMessage(err)}`);
			return;
		}
		const asCard = this.settings.defaultView === "card";
		const node = canvas.createFileNode({
			pos,
			size: this.newNodeSize(canvas),
			position: centered ? "center" : undefined,
			file,
			save: !asCard, // a card is only saved once it got a name
		});
		node.attach();
		node.render();

		if (!asCard) {
			// give the embed a moment to load the (empty) file
			window.setTimeout(() => {
				node.startEditing();
				node.child?.focusTitle?.();
			}, 100);
			return;
		}
		this.startTitleEdit(
			node,
			"",
			(name) => void this.nameNewNote(canvas, file, name),
			() => void this.dropNewNote(canvas, node, file),
		);
	}

	private async nameNewNote(canvas: Canvas, file: TFile, name: string) {
		try {
			await this.app.fileManager.renameFile(file, this.availablePath(file.parent?.path ?? "/", name));
		} catch (err) {
			new Notice(`Could not name note "${name}", kept it as "${file.basename}": ${errorMessage(err)}`);
		}
		canvas.requestSave();
	}

	private async dropNewNote(canvas: Canvas, node: CanvasNode, file: TFile) {
		canvas.removeNode(node);
		// only ever delete the placeholder we just created
		if ((await this.app.vault.read(file)) === "") await this.app.fileManager.trashFile(file);
	}

	private availablePath(folder: string, name: string): string {
		const base = folder === "/" || folder === "" ? name : `${folder}/${name}`;
		let path = normalizePath(`${base}.md`);
		for (let i = 1; this.app.vault.getAbstractFileByPath(path); i++) {
			path = normalizePath(`${base} ${i}.md`);
		}
		return path;
	}

	private async createNote(canvas: Canvas, name: string): Promise<TFile> {
		// Honors Settings -> Files and links -> Default location for new notes,
		// same as the built-in "Convert to file...".
		const parent = this.app.fileManager.getNewFileParent(canvas.view.file?.path ?? "", name);
		return this.app.vault.create(this.availablePath(parent.path, name), "");
	}
}

/** The note (or the section a node is narrowed to) as an editable document in a modal. */
class NoteModal extends Modal {
	private embed: MarkdownEmbed | null = null;

	constructor(
		app: App,
		private file: TFile,
		private subpath: string,
	) {
		super(app);
	}

	async onOpen() {
		const { app, file, subpath } = this;
		this.modalEl.addClass("note-card-modal");
		if (subpath) this.titleEl.setText(`${file.basename} › ${subpath.substring(1)}`);

		try {
			const createEmbed = (app as unknown as { embedRegistry: { embedByExtension: Record<string, EmbedCreator> } })
				.embedRegistry.embedByExtension.md;
			const containerEl = this.contentEl.createDiv();
			const embed = createEmbed({ app, linktext: file.path + subpath, sourcePath: "", containerEl, depth: 0 }, file, subpath);
			this.embed = embed;
			embed.editable = true;
			embed.load();
			await embed.loadFile();
			if (this.embed !== embed) return; // closed in the meantime
			embed.showEditor();
			app.workspace.activeEditor = embed as unknown as MarkdownFileInfo;
		} catch (err) {
			console.error("Note Cards: could not open the note editor", err);
			new Notice("Could not open the note editor in this version of Obsidian.");
			this.close();
		}
	}

	close() {
		// commit a title rename that is still being typed
		const active = this.modalEl.doc.activeElement;
		if (active instanceof HTMLElement && this.modalEl.contains(active)) active.blur();
		super.close();
	}

	onClose() {
		const embed = this.embed;
		this.embed = null;
		if (embed) {
			embed.showPreview(true); // flushes unsaved edits
			embed.unload();
		}
		this.contentEl.empty();
	}
}

const SETTING_NAME = "Default note view";
const SETTING_DESC = "View for notes newly added to a canvas. Notes already on a canvas are not affected.";
const VIEW_OPTIONS: Record<NodeView, string> = { note: "Note", card: "Card" };

class NoteCardsSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: NoteCardsPlugin,
	) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: SETTING_NAME,
				desc: SETTING_DESC,
				control: {
					type: "dropdown",
					key: "defaultView",
					defaultValue: DEFAULT_SETTINGS.defaultView,
					options: VIEW_OPTIONS,
				},
			},
		];
	}

	/** Fallback for Obsidian versions before 1.13.0, which do not know getSettingDefinitions(). */
	display() {
		this.containerEl.empty();
		new Setting(this.containerEl)
			.setName(SETTING_NAME)
			.setDesc(SETTING_DESC)
			.addDropdown((dropdown) =>
				dropdown
					.addOptions(VIEW_OPTIONS)
					.setValue(this.plugin.settings.defaultView)
					.onChange(async (value) => {
						this.plugin.settings.defaultView = value as NodeView;
						await this.plugin.saveSettings();
					}),
			);
	}
}
