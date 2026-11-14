// CodeMirror setup. On: syntax colours, auto-indent, closing of tags and brackets, completion of
// tag names and CSS properties, line numbers, Emmet abbreviations in HTML. Off: linting, minimap,
// code folding, search.
//
// Every colour and the font come from CSS variables (see style.css), so light mode, dark mode
// and a change of look need no new editor state.

import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { HighlightStyle, bracketMatching, indentOnInput, indentUnit, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { EditorState, type Extension, type StateCommand } from "@codemirror/state";
import { EditorView, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { expandAbbreviation } from "@emmetio/codemirror6-plugin";
import { tags as t } from "@lezer/highlight";
import { ext } from "../../src/shared/rules";

function language(path: string): Extension {
  switch (ext(path)) {
    case "html":
    case "htm":
    case "svg":
    case "xml":
      return html();
    case "css":
      return css();
    case "js":
    case "mjs":
      return javascript();
    case "json":
    case "webmanifest":
      return json();
    default:
      return [];
  }
}

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "var(--code-size)", color: "var(--code-fg)", backgroundColor: "var(--code-bg)" },
  // No ligatures: a beginner must see the characters that were typed, so => stays = and >.
  ".cm-scroller": { fontFamily: "var(--mono)", fontVariantLigatures: "none", lineHeight: "1.6" },
  ".cm-content": { padding: "10px 0 40px", caretColor: "var(--accent)" },
  ".cm-line": { padding: "0 16px 0 6px" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  ".cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    backgroundColor: "var(--code-select)",
  },
  ".cm-gutters": { backgroundColor: "var(--code-bg)", border: "none", color: "var(--code-dim)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 14px", minWidth: "2.5em" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--code-fg)" },
  ".cm-activeLine": { backgroundColor: "var(--code-line)" },
  "&:not(.cm-focused) .cm-activeLine": { backgroundColor: "transparent" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "var(--code-select)",
    outline: "1px solid var(--code-dim)",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--white)",
    color: "var(--black)",
    border: "1px solid var(--line)",
    borderRadius: "var(--radius)",
    overflow: "hidden",
  },
  ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--mono)" },
  ".cm-tooltip-autocomplete > ul > li": { padding: "3px 10px" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--accent)", color: "var(--on-accent)" },
  ".cm-completionIcon": { display: "none" },
});

const colours = HighlightStyle.define([
  { tag: [t.comment, t.meta], color: "var(--tok-comment)", fontStyle: "italic" },
  { tag: [t.tagName, t.angleBracket, t.documentMeta], color: "var(--tok-tag)" },
  { tag: [t.attributeName, t.propertyName], color: "var(--tok-name)" },
  { tag: [t.string, t.attributeValue, t.special(t.string)], color: "var(--tok-string)" },
  { tag: [t.number, t.unit, t.color, t.bool, t.atom, t.null], color: "var(--tok-number)" },
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.definitionKeyword], color: "var(--tok-keyword)", fontWeight: "var(--tok-keyword-weight)" },
  { tag: [t.className, t.labelName, t.typeName, t.namespace], color: "var(--tok-selector)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--tok-function)" },
  { tag: [t.punctuation, t.separator, t.bracket, t.operator], color: "var(--tok-punct)" },
  { tag: t.invalid, color: "var(--error)" },
]);

const HTML_TAGS = new Set(
  `a abbr address article aside audio b blockquote body br button canvas caption cite code col colgroup dd details dialog div dl
  dt em fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hr html i iframe img input label legend li link main
  mark meta nav ol optgroup option p picture pre q script section select small source span strong style sub summary sup table
  tbody td textarea tfoot th thead time title tr u ul video`.split(/\s+/),
);

/**
 * Tab expands an Emmet abbreviation in HTML: img becomes <img src="" alt=""> with the cursor in
 * src, and ul>li*4>a>img becomes the whole nested list. Tab then steps to the next empty spot.
 *
 * Emmet itself would turn any word into a tag, so "tekst" plus Tab would give <tekst></tekst>.
 * Here Tab only expands when the abbreviation starts with a real HTML tag, a class (.name), an
 * id (#name) or !, and the cursor is in the text of the page: not inside a tag, a comment, a
 * script or a style. Everywhere else Tab indents as before.
 */
const expandOnTab: StateCommand = (target) => {
  const { state } = target;
  const range = state.selection.main;
  if (!range.empty) return false;
  for (let node: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(state).resolveInner(range.head, -1); node; node = node.parent) {
    if (/Tag$|^Comment$|^Script$|^Style$|Attribute/.test(node.name)) return false;
  }
  const line = state.doc.lineAt(range.head);
  const word = /[A-Za-z.#!][^\s<>]*$/.exec(line.text.slice(0, range.head - line.from))?.[0];
  if (!word) return false;
  const tag = /^[A-Za-z][A-Za-z0-9]*/.exec(word)?.[0].toLowerCase();
  if (tag ? !HTML_TAGS.has(tag) : !/^[.#!]/.test(word)) return false;
  return expandAbbreviation(target);
};

/** The drag type of a row in the file tree. Its data is the path of the file. */
export const DRAG = "text/x-maak-path";

/** What a box does with things dropped on its code. Each answer is the text to insert, or nothing. */
export interface Drops {
  /** A file dragged from the file tree. */
  path(from: string): string | null;
  /** Files dragged in from the computer. They are uploaded first. */
  files(files: File[]): Promise<string | null>;
}

/** Puts text at a position and leaves the cursor inside the first empty alt="", ready to describe the image. */
function insertAt(view: EditorView, at: number, text: string): void {
  const pos = Math.min(at, view.state.doc.length);
  const alt = text.indexOf('alt=""');
  const cursor = pos + (alt < 0 ? text.length : alt + 5);
  view.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: cursor }, scrollIntoView: true });
  view.focus();
}

function dropHandlers(drops: Drops): Extension {
  const images = (e: DragEvent) => [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
  return [
    // Shows where the dropped text will land while the pointer moves over the code.
    dropCursor(),
    EditorView.domEventHandlers({
      dragover(e) {
        const types = e.dataTransfer?.types ?? [];
        if (!types.includes(DRAG) && !types.includes("Files")) return false;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
        return false;
      },
      drop(e, view) {
        // false: the nearest position, also for a drop in the empty space below the last line.
        const at = view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
        const from = e.dataTransfer?.getData(DRAG);
        if (from) {
          const text = drops.path(from);
          e.preventDefault();
          if (text) insertAt(view, at, text);
          return true;
        }
        const files = images(e);
        if (!files.length) return false;
        e.preventDefault();
        void drops.files(files).then((text) => text && insertAt(view, at, text));
        return true;
      },
    }),
  ];
}

export function makeState(
  path: string,
  text: string,
  readOnly: boolean,
  label: string,
  onChange: (text: string) => void,
  drops?: Drops,
): EditorState {
  return EditorState.create({
    doc: text,
    extensions: [
      drops && !readOnly ? dropHandlers(drops) : [],
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      history(),
      drawSelection(),
      indentOnInput(),
      indentUnit.of("  "),
      EditorState.tabSize.of(2),
      bracketMatching(),
      closeBrackets(),
      autocompletion({ icons: false }),
      // Tab indents. Escape followed by Tab leaves the editor, for keyboard users.
      keymap.of([
        ...(/^html?$/.test(ext(path)) ? [{ key: "Tab", run: expandOnTab }] : []),
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...completionKeymap,
        indentWithTab,
      ]),
      language(path),
      syntaxHighlighting(colours),
      theme,
      EditorView.lineWrapping,
      EditorState.readOnly.of(readOnly),
      EditorView.contentAttributes.of({ "aria-label": label }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChange(update.state.doc.toString());
      }),
    ],
  });
}

export function emptyState(): EditorState {
  return EditorState.create({ doc: "", extensions: [EditorState.readOnly.of(true), theme] });
}

export { EditorView, EditorState };
