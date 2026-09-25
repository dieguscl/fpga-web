import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { verilog } from '@codemirror/legacy-modes/mode/verilog';
import { tags as t } from '@lezer/highlight';

// HexaFlex palette via CSS variables, so the editor follows the page's light/dark theme.
const hexaflexTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--hf-surface)', color: 'var(--hf-text)', fontSize: '13px' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  '.cm-content': { caretColor: 'var(--hf-primary)', padding: '12px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--hf-primary)', borderLeftWidth: '2px' },
  '.cm-gutters': { backgroundColor: 'var(--hf-surface)', color: 'var(--hf-text-faint)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 14px 0 18px' },
  '.cm-activeLine': { backgroundColor: 'var(--hf-hover)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--hf-primary)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--hf-primary) 22%, transparent) !important',
  },
  '.cm-matchingBracket': { backgroundColor: 'color-mix(in srgb, var(--hf-tertiary) 20%, transparent)', outline: 'none' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--hf-surface-container-highest)', border: 'none', color: 'var(--hf-text-muted)' },
  '.cm-tooltip, .cm-panels': { backgroundColor: 'var(--hf-surface-container-high)', color: 'var(--hf-text)', border: 'none' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--hf-tertiary) 25%, transparent)' },
});

const hexaflexHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword], color: 'var(--hf-primary)', fontWeight: '600' },
  { tag: [t.typeName, t.standard(t.name), t.definitionKeyword], color: 'var(--hf-tertiary)' },
  { tag: [t.number, t.bool, t.atom], color: 'var(--syn-number)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--syn-string)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--hf-text-muted)', fontStyle: 'italic' },
  { tag: [t.meta, t.processingInstruction], color: 'var(--syn-meta)' },
  { tag: [t.operator, t.punctuation, t.bracket], color: 'var(--hf-text-secondary)' },
  { tag: [t.variableName, t.propertyName], color: 'var(--hf-text)' },
]);

export class Editor {
  private view: EditorView;
  constructor(parent: HTMLElement, private onChange: (text: string) => void) {
    this.view = new EditorView({ parent, state: this.state('', false) });
  }
  private state(text: string, readOnly: boolean): EditorState {
    return EditorState.create({
      doc: text,
      extensions: [
        basicSetup,
        StreamLanguage.define(verilog),
        hexaflexTheme,
        syntaxHighlighting(hexaflexHighlight),
        EditorState.readOnly.of(readOnly),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) this.onChange(u.state.doc.toString());
        }),
      ],
    });
  }
  // readOnly is additive to the Task 14 interface (setDoc(name, text)) --
  // used for the "no file open" empty state (e.g. after deleting the last
  // file), where there is nothing meaningful to type into.
  setDoc(_name: string, text: string, readOnly = false): void {
    this.view.setState(this.state(text, readOnly));
  }
  gotoLine(line: number): void {
    const doc = this.view.state.doc;
    const l = doc.line(Math.min(Math.max(1, line), doc.lines));
    this.view.dispatch({ selection: { anchor: l.from }, scrollIntoView: true });
    this.view.focus();
  }
}
