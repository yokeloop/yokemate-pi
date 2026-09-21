import assert from "node:assert/strict";
import { test } from "node:test";
import type { EditorComponent } from "@earendil-works/pi-tui";
import { installWorkflowIngress, WorkflowIngressWitnessStore } from "../src/workflow-ingress.ts";

class FakeEditor implements EditorComponent {
  text = "";
  focused = false;
  wantsKeyRelease = true;
  mouseEvents = 0;
  actionHandlers = new Map<any, () => void>();
  onEscape?: () => void;
  onCtrlD?: () => void;
  onPasteImage?: () => void;
  onExtensionShortcut?: (data: string) => boolean;
  workingStatus: unknown;
  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;
  getText() { return this.text; }
  getExpandedText() { return this.text.replace("[paste]", "  expanded\ntext  "); }
  setText(text: string) { this.text = text; }
  handleInput(data: string) {
    if (data === "ENTER") {
      const submitted = this.text.trim();
      this.text = "";
      this.onSubmit?.(submitted);
    } else if (data === "COMPLETE") {
      this.text += "completion";
      this.onChange?.(this.text);
    } else this.text += data;
  }
  handleMouse() { this.mouseEvents++; return undefined; }
  render() { return [this.text]; }
  invalidate() {}
  onAction(action: any, handler: () => void) { this.actionHandlers.set(action, handler); }
  setWorkingStatusIndicator(indicator: unknown) { this.workingStatus = indicator; }
}

test("delegating editor witnesses only an actual host submit and snapshots raw expanded text before trim and clear", () => {
  const prior = () => new FakeEditor();
  let factory: any = prior;
  const ui = { getEditorComponent: () => factory, setEditorComponent: (value: any) => { factory = value; } };
  const raw: string[] = [];
  const uninstall = installWorkflowIngress(ui, (value) => raw.push(value));
  const wrapped = factory({}, {}, {});
  const submitted: string[] = [];
  wrapped.onSubmit = (value: string) => submitted.push(value);
  wrapped.focused = true;
  assert.equal(wrapped.focused, true);
  assert.equal(wrapped.wantsKeyRelease, true);
  assert.equal(wrapped.handleMouse?.({} as never), undefined);
  const custom = wrapped as any;
  const escape = () => undefined;
  custom.onEscape = escape;
  custom.onCtrlD = escape;
  custom.onPasteImage = escape;
  custom.onExtensionShortcut = () => true;
  custom.onAction("app.interrupt", escape);
  custom.setWorkingStatusIndicator("working");
  const delegate = (custom as { delegate: FakeEditor }).delegate;
  assert.equal(delegate.onEscape, escape);
  assert.equal(delegate.onCtrlD, escape);
  assert.equal(delegate.onPasteImage, escape);
  assert.equal(delegate.onExtensionShortcut?.("x"), true);
  assert.equal(delegate.actionHandlers.get("app.interrupt"), escape);
  assert.equal(delegate.workingStatus, "working");
  wrapped.setText("  exact raw  ");
  wrapped.handleInput("COMPLETE");
  assert.deepEqual(raw, []);
  wrapped.setText("[paste]");
  wrapped.handleInput("ENTER");
  assert.deepEqual(raw, ["  expanded\ntext  "]);
  assert.deepEqual(submitted, ["[paste]"]);
  assert.equal(wrapped.getText(), "");
  wrapped.onSubmit?.("direct");
  assert.deepEqual(raw, ["  expanded\ntext  "], "direct callbacks are not typed submits");
  uninstall();
  assert.equal(factory, prior);
});

test("witness store advances raw generation synchronously and is exact-session single use", () => {
  const store = new WorkflowIngressWitnessStore();
  const first = store.submit(" /break-glass exact ", "session", "runtime", 1);
  assert.equal(first.generation, 1);
  assert.equal(store.read(first.id)?.raw, first.raw);
  const second = store.submit("ordinary", "session", "runtime", 2);
  assert.equal(second.generation, 2);
  assert.equal(store.read(first.id), undefined);
  assert.throws(() => store.consume(second.id, "foreign", "runtime", second.raw), /exact typed/);
  assert.equal(store.consume(second.id, "session", "runtime", second.raw).consumed, true);
  assert.throws(() => store.consume(second.id, "session", "runtime", second.raw), /exact typed/);
  store.revoke();
  assert.equal(store.read(second.id), undefined);
});
