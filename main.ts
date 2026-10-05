import { around } from "monkey-around";
import {
	App,
	Component,
	ItemView,
	MarkdownRenderer,
	Menu,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	WorkspaceLeaf,
	normalizePath,
	resolveSubpath,
	setIcon,
	setTooltip,
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
	render(): void;
	setData(data: unknown): void;
	// file nodes only
	file?: TFile | null;
	filePath?: string;
	subpath?: string;
}
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
	createFileNode(opts: { pos: Pos; size?: Size; position?: string; file: TFile }): CanvasNode;
	dragTempNode(evt: PointerEvent, size: Size, onDrop: (pos: Pos) => void): void;
	addNode(node: CanvasNode): void;
	requestSave(): void;
}

function isNoteNode(node: CanvasNode): boolean {
	return node.filePath !== undefined && node.file?.extension === "md";
}

function cardTitle(node: CanvasNode): string {
	const subpath = node.subpath ?? "";
	// "#Heading" or "#Parent#Child" - block references ("#^id") fall back to the file name
	if (subpath.startsWith("#") && !subpath.startsWith("#^")) {
		const heading = subpath.split("#").pop();
		if (heading) return heading;
	}
	return node.file?.basename ?? node.filePath ?? "";
}

export default class NoteCardsPlugin extends Plugin {
	settings: NoteCardsSettings = DEFAULT_SETTINGS;
	private canvasPatched = false;
	// true while the canvas is creating a brand new file node (as opposed to loading one)
	private creatingNode = false;
	private nodePatched = false;

	async onload() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const workspace = this.app.workspace as any;
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
		// eslint-disable-next-line @typescript-eslint/no-this-alias
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
		// eslint-disable-next-line @typescript-eslint/no-this-alias
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

	private syncNode(node: CanvasNode) {
		const container = node.containerEl;
		if (!container) return; // not initialized yet, render() will get back to us
		const isCard = isNoteNode(node) && this.viewOf(node) === "card";
		node.nodeEl.toggleClass("is-note-card", isCard);

		let cardEl = container.querySelector<HTMLElement>(":scope > .note-card");
		if (!isCard) {
			cardEl?.remove();
			return;
		}
		cardEl ??= this.buildCard(node, container);
		cardEl.querySelector(".note-card-title")?.setText(cardTitle(node));
	}

	private buildCard(node: CanvasNode, container: HTMLElement): HTMLElement {
		const cardEl = container.createDiv("note-card");
		cardEl.createDiv("note-card-title");
		cardEl.addEventListener("dblclick", (evt) => {
			// the node would otherwise start editing the (hidden) embedded note
			evt.preventDefault();
			if (node.file) void this.goToDocument(node.file, node.subpath ?? "");
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
		addAction("eye", "Preview", (file) => new PreviewModal(this.app, file, node.subpath ?? "").open());
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
		button.addEventListener("click", () => this.promptNewNote(canvas, canvas.posCenter(), true));
		button.addEventListener("pointerdown", (evt) =>
			canvas.dragTempNode(evt, this.newNodeSize(canvas), (pos) => this.promptNewNote(canvas, pos, false)),
		);
	}

	private newNodeSize(canvas: Canvas): Size {
		return this.settings.defaultView === "card" ? CARD_SIZE : canvas.config.defaultFileNodeDimensions;
	}

	private promptNewNote(canvas: Canvas, pos: Pos, centered: boolean) {
		new NoteNameModal(this.app, async (name) => {
			try {
				const file = await this.createNote(canvas, name);
				canvas.createFileNode({
					pos,
					size: this.newNodeSize(canvas),
					position: centered ? "center" : undefined,
					file,
				});
			} catch (err) {
				new Notice(`Could not create note: ${err instanceof Error ? err.message : err}`);
			}
		}).open();
	}

	private async createNote(canvas: Canvas, name: string): Promise<TFile> {
		// Honors Settings -> Files and links -> Default location for new notes,
		// same as the built-in "Convert to file...".
		const parent = this.app.fileManager.getNewFileParent(canvas.view.file?.path ?? "", name);
		const base = parent.isRoot() ? name : `${parent.path}/${name}`;
		let path = normalizePath(`${base}.md`);
		for (let i = 1; this.app.vault.getAbstractFileByPath(path); i++) {
			path = normalizePath(`${base} ${i}.md`);
		}
		return this.app.vault.create(path, "");
	}
}

class NoteNameModal extends Modal {
	constructor(
		app: App,
		private onSubmit: (name: string) => void,
	) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText("New note");
		let name = "";
		const submit = () => {
			this.close();
			this.onSubmit(name.trim() || "Untitled");
		};
		new Setting(this.contentEl)
			.setName("Name")
			.addText((text) => {
				text.setPlaceholder("Untitled").onChange((value) => (name = value));
				text.inputEl.addEventListener("keydown", (evt) => {
					if (evt.key === "Enter" && !evt.isComposing) {
						evt.preventDefault();
						submit();
					}
				});
				window.setTimeout(() => text.inputEl.focus());
			})
			.addButton((button) => button.setButtonText("Create").setCta().onClick(submit));
	}

	onClose() {
		this.contentEl.empty();
	}
}

class PreviewModal extends Modal {
	private component = new Component();

	constructor(
		app: App,
		private file: TFile,
		private subpath: string,
	) {
		super(app);
	}

	async onOpen() {
		const { file, subpath } = this;
		this.modalEl.addClass("note-card-preview");
		this.titleEl.setText(subpath ? `${file.basename} › ${subpath.substring(1)}` : file.basename);
		this.component.load();

		let markdown = await this.app.vault.cachedRead(file);
		const cache = this.app.metadataCache.getFileCache(file);
		const section = subpath && cache ? resolveSubpath(cache, subpath) : null;
		if (section) {
			markdown = markdown.slice(section.start.offset, section.end?.offset);
		} else if (cache?.frontmatterPosition) {
			markdown = markdown.slice(cache.frontmatterPosition.end.offset);
		}
		const body = this.contentEl.createDiv("markdown-rendered");
		await MarkdownRenderer.render(this.app, markdown, body, file.path, this.component);
	}

	onClose() {
		this.component.unload();
		this.contentEl.empty();
	}
}

class NoteCardsSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: NoteCardsPlugin,
	) {
		super(app, plugin);
	}

	display() {
		this.containerEl.empty();
		new Setting(this.containerEl)
			.setName("Default note view")
			.setDesc("View for notes newly added to a canvas. Notes already on a canvas are not affected.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("note", "Note")
					.addOption("card", "Card")
					.setValue(this.plugin.settings.defaultView)
					.onChange(async (value) => {
						this.plugin.settings.defaultView = value as NodeView;
						await this.plugin.saveSettings();
					}),
			);
	}
}
