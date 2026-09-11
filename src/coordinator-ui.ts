import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Editor, Spacer, Text, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";

class CoordinatorEditor extends Container implements Focusable {
  private readonly editor: Editor;
  private done = false;
  private readonly cancel: () => void;
  private readonly removeAbort: () => void;
  private _focused = false;

  constructor(tui: TUI, keybindings: KeybindingsManager, theme: { fg(name: string, text: string): string }, title: string, prefill: string | undefined, finish: (value: string | undefined) => void, signal: AbortSignal) {
    super();
    this.tui = tui;
    this.keybindings = keybindings;
    const close = (value: string | undefined) => {
      if (this.done) return;
      this.done = true;
      this.removeAbort();
      finish(value);
    };
    this.cancel = () => close(undefined);
    const onAbort = () => close(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    this.removeAbort = () => signal.removeEventListener("abort", onAbort);
    this.addChild(new Text(title, 1, 0));
    this.addChild(new Spacer(1));
    this.editor = new Editor(tui, {
      borderColor: (text) => theme.fg("borderMuted", text),
      selectList: {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("muted", text),
        noMatch: (text) => theme.fg("muted", text),
      },
    });
    if (prefill) this.editor.setText(prefill);
    this.editor.onSubmit = (value) => close(value);
    this.addChild(this.editor);
    this.addChild(new Spacer(1));
    this.addChild(new Text("Enter submits · Escape cancels", 1, 0));
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) return this.cancel();
    this.editor.handleInput(data);
    this.tui.requestRender();
  }

  private readonly tui: TUI;
  private readonly keybindings: KeybindingsManager;
  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.editor.focused = value; }
  dispose(): void { this.removeAbort(); }
}

export async function showCoordinatorEditor(ctx: ExtensionContext, title: string, prefill: string | undefined, signal: AbortSignal): Promise<string | undefined> {
  if (ctx.mode !== "tui" || signal.aborted) return undefined;
  return ctx.ui.custom((tui, theme, keybindings, done) => new CoordinatorEditor(tui, keybindings, theme, title, prefill, done, signal));
}
