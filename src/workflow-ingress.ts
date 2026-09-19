import { randomUUID } from "node:crypto";
import { CustomEditor, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider, EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { sha256 } from "./subagent-runs.ts";

export interface WorkflowIngressWitness {
  id: string;
  sessionId: string;
  runtimeId: string;
  generation: number;
  raw: string;
  hash: string;
  submittedAt: number;
  consumed: boolean;
}

export class WorkflowIngressWitnessStore {
  private generation = 0;
  private current?: WorkflowIngressWitness;
  submit(raw: string, sessionId: string, runtimeId: string, now = Date.now()): WorkflowIngressWitness {
    if (this.current) this.current.consumed = true;
    const witness: WorkflowIngressWitness = { id: randomUUID(), sessionId, runtimeId, generation: ++this.generation, raw, hash: sha256(raw), submittedAt: now, consumed: false };
    this.current = witness;
    return { ...witness };
  }
  read(id: string): WorkflowIngressWitness | undefined {
    const witness = this.current;
    return witness?.id === id ? { ...witness } : undefined;
  }
  consume(id: string, sessionId: string, runtimeId: string, raw: string): WorkflowIngressWitness {
    const witness = this.current;
    if (!witness || witness.id !== id || witness.consumed || witness.sessionId !== sessionId || witness.runtimeId !== runtimeId || witness.raw !== raw || witness.hash !== sha256(raw)) throw new Error("break-glass requires the current exact typed submit");
    witness.consumed = true;
    return { ...witness };
  }
  revoke(): void { if (this.current) this.current.consumed = true; this.current = undefined; }
}

type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;

class DelegatingEditor implements EditorComponent {
  private delegate: EditorComponent;
  private beforeInput?: string;
  private handling = false;
  private submitHandler?: (text: string) => void;
  private readonly submitted: (raw: string) => void;
  constructor(delegate: EditorComponent, submitted: (raw: string) => void) {
    this.delegate = delegate;
    this.submitted = submitted;
    this.delegate.onSubmit = (text) => {
      if (this.handling && this.beforeInput !== undefined) this.submitted(this.beforeInput);
      this.submitHandler?.(text);
    };
  }
  get onSubmit(): ((text: string) => void) | undefined { return this.submitHandler; }
  set onSubmit(value: ((text: string) => void) | undefined) { this.submitHandler = value; }
  get onChange(): ((text: string) => void) | undefined { return this.delegate.onChange; }
  set onChange(value: ((text: string) => void) | undefined) { this.delegate.onChange = value; }
  get borderColor(): ((str: string) => string) | undefined { return this.delegate.borderColor; }
  set borderColor(value: ((str: string) => string) | undefined) { this.delegate.borderColor = value; }
  getText(): string { return this.delegate.getText(); }
  setText(text: string): void { this.delegate.setText(text); }
  getExpandedText(): string { return this.delegate.getExpandedText?.() ?? this.delegate.getText(); }
  handleInput(data: string): void {
    this.beforeInput = this.getExpandedText();
    this.handling = true;
    try { this.delegate.handleInput(data); }
    finally { this.handling = false; this.beforeInput = undefined; }
  }
  render(width: number): string[] { return this.delegate.render(width); }
  invalidate(): void { this.delegate.invalidate(); }
  addToHistory(text: string): void { this.delegate.addToHistory?.(text); }
  insertTextAtCursor(text: string): void { this.delegate.insertTextAtCursor?.(text); }
  setAutocompleteProvider(provider: AutocompleteProvider): void { this.delegate.setAutocompleteProvider?.(provider); }
  setPaddingX(padding: number): void { this.delegate.setPaddingX?.(padding); }
  setAutocompleteMaxVisible(maxVisible: number): void { this.delegate.setAutocompleteMaxVisible?.(maxVisible); }
}

export function installWorkflowIngress(ui: Pick<ExtensionUIContext, "getEditorComponent" | "setEditorComponent">, submitted: (raw: string) => void): () => void {
  const prior = ui.getEditorComponent();
  const fallback: EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => new CustomEditor(tui, theme, keybindings);
  const installed: EditorFactory = (tui, theme, keybindings) => new DelegatingEditor((prior ?? fallback)(tui, theme, keybindings), submitted);
  ui.setEditorComponent(installed);
  return () => { if (ui.getEditorComponent() === installed) ui.setEditorComponent(prior); };
}
