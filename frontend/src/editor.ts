import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { StreamLanguage } from '@codemirror/language';
import { verilog } from '@codemirror/legacy-modes/mode/verilog';

export class Editor {
  private view: EditorView;
  constructor(parent: HTMLElement, private onChange: (text: string) => void) {
    this.view = new EditorView({ parent, state: this.state('') });
  }
  private state(text: string): EditorState {
    return EditorState.create({
      doc: text,
      extensions: [
        basicSetup,
        StreamLanguage.define(verilog),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) this.onChange(u.state.doc.toString());
        }),
      ],
    });
  }
  setDoc(_name: string, text: string): void {
    this.view.setState(this.state(text));
  }
  gotoLine(line: number): void {
    const doc = this.view.state.doc;
    const l = doc.line(Math.min(Math.max(1, line), doc.lines));
    this.view.dispatch({ selection: { anchor: l.from }, scrollIntoView: true });
    this.view.focus();
  }
}
