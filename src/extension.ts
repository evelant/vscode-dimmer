'use strict';

import * as vscode from 'vscode';
import * as utils from './utils';

let TAB_SIZE = 4;

let enabled = false;
let contextIndex = 0;
let opacity = 50;
let delay = 200;
let commandScope = true;
let HLRange: vscode.Range[] = [];
let fixedRange: vscode.Range | undefined = undefined

let dimDecoration: vscode.TextEditorDecorationType;
let normalDecoration = vscode.window.createTextEditorDecorationType(<vscode.DecorationRenderOptions>{
    textDecoration: 'none; opacity: 1'
});
let highlightedDecoration = vscode.window.createTextEditorDecorationType(<vscode.DecorationRenderOptions>{
    backgroundColor: 'rgba(255, 165, 0, 0.2)', // Opacity background color (orange with 20% opacity)
});

let lineTable = new Map(); // Line dict

let delayers: { [key: string]: utils.ThrottledDelayer<void> } = Object.create(null);
let dimmingReason = 'indentAndBrackets'
let statusBarButton: vscode.StatusBarItem = null;
let lastRange: vscode.Range = null;

export function activate(context: vscode.ExtensionContext) {
    let configRegistration = vscode.workspace.onDidChangeConfiguration((e) => {
        initialize(context)
    })
    let selectionRegistration = vscode.window.onDidChangeTextEditorSelection((e) => {
        updateIfEnabled(e.textEditor, context);
    });
    let textEditorChangeRegistration = vscode.window.onDidChangeActiveTextEditor((e) => {
        updateIfEnabled(e, context);
    });
    let toggleCommandRegistration = vscode.commands.registerCommand('dimmer.ToggleDimmer', () => {
        vscode.workspace.getConfiguration('dimmer').update("enabled", !enabled, commandScope)
    });
    let fixCommandRegistration = vscode.commands.registerCommand('dimmer.FixDimmer', () => {
        fixedRange = lastRange
    });

    initialize(context);

    configureStatusBar(context)
    context.subscriptions.push(selectionRegistration, configRegistration, toggleCommandRegistration, fixCommandRegistration, textEditorChangeRegistration);

    vscode.commands.executeCommand('dimmer.FixDimmer').then(() => {
        console.log('FixDimmer command executed successfully');
    }, (err) => {
        console.error('Failed to execute FixDimmer command:', err);
    });
}

function updateIfEnabled(textEditor: vscode.TextEditor, context: vscode.ExtensionContext) {
    if (enabled) {
        setDecorations(textEditor, context);
    }
}

function initialize(context: vscode.ExtensionContext) {
    resetAllDecorations(context);

    readConfig();
    createDimDecorator();

    setAllDecorations(context);

    updateStatusBarIcon()
}

function readConfig() {
    let config = vscode.workspace.getConfiguration('dimmer');
    commandScope = config.get('toggleDimmerCommandScope', 'user') === 'user';
    enabled = commandScope 
        ? config.inspect("enabled")?.globalValue === true
        : config.get('enabled', false)
    opacity = config.get('opacity', 50);
    contextIndex = config.get('context', 0);
    delay = config.get('delay', 200);
    delay = delay < 0 ? 0 : delay;
    dimmingReason = config.get('dimmingReason', 'indentAndBrackets');
}

function resetAllDecorations(context: vscode.ExtensionContext) {
    vscode.window.visibleTextEditors.forEach(textEditor => {
        resetDecorations(textEditor, context);
    });
}

function resetDecorations(textEditor: vscode.TextEditor, context: vscode.ExtensionContext) {
    highlightSelections(textEditor, [], context);
    undimEditor(textEditor);
}

function setAllDecorations(context: vscode.ExtensionContext) {
    vscode.window.visibleTextEditors.forEach((e) => {
        updateIfEnabled(e, context);
    });
}

function setDecorations(textEditor: vscode.TextEditor, context: vscode.ExtensionContext) {
    let filename = textEditor.document.fileName;
    let delayer = delayers[filename];
    if (!delayer) {
        delayer = new utils.ThrottledDelayer<void>(delay);
        delayers[filename] = delayer;
    }
    delayer.trigger(() => {
        return Promise.resolve().then(() => {
            dimEditor(textEditor);
            if (fixedRange) {
                textEditor.setDecorations(highlightedDecoration, [fixedRange]);
            }
            if (dimmingReason === 'indent') {
                highlightSelections(textEditor, textEditor.selections, context);
            }
        });
    }, delay);
}

function highlightSelections(editor: vscode.TextEditor, selections: readonly vscode.Selection[], context: vscode.ExtensionContext) {
    if (!normalDecoration) return;

    let ranges: vscode.Range[] = [];
    selections.forEach(s => {
        const range = new vscode.Range(s.start, s.end)
        if (contextIndex < 0) {
            ranges.push(range);
        }
        else {
            ranges.push(new vscode.Range(
                new vscode.Position(Math.max(range.start.line - contextIndex, 0), 0),
                new vscode.Position(range.end.line + contextIndex, Number.MAX_VALUE)
            ));
        }
    });
    editor.setDecorations(normalDecoration, ranges);

    context.globalState.update(
        'dimmer.highlighted_ranges', 
        {
            'workspace': vscode.workspace.name,
            'file': editor.document.fileName,
            'ranges': ranges
        }
    );
}

function createDimDecorator() {
    if (dimDecoration) {
        dimDecoration.dispose();
    }
    dimDecoration = vscode.window.createTextEditorDecorationType(<vscode.DecorationRenderOptions>{
        textDecoration: `none; opacity: ${opacity / 100}`
    });
}

function undimEditor(editor: vscode.TextEditor) {
    if (!dimDecoration) return;
    editor.setDecorations(dimDecoration, []);
    editor.setDecorations(highlightedDecoration, []);
}

function dimEditor(editor: vscode.TextEditor) {
    if (!dimDecoration) return;

    if (editor.selection.isSingleLine) {
        let topLine = findTop(editor);
        let botLine = findBot(editor, topLine);
        // let HLRange : vscode.Range;

        // If top level statement that doesn't start a block the entire file is in it's context
        // if(editor.document.lineAt(editor.selection.active).firstNonWhitespaceCharacterIndex === 0
        if (getIndentLevel(editor, editor.document.lineAt(editor.selection.active)) === 0
            && !editor.document.lineAt(editor.selection.active).isEmptyOrWhitespace && dimmingReason === 'indent') {
            // Do nothing for now
            // this.unhighlightAll(editor);
        } else {
            // HLRange = new vscode.Range(topLine.lineNumber,0 ,
            // botLine.lineNumber, Number.MAX_VALUE);
            let needDimIndent = true;
            if (dimmingReason !== 'indent') {
                // Bracket-based dimming within the HLRange
                let selectionIndex = editor.document.offsetAt(editor.selection.active);
                let bracketRange = findSurroundingBrackets(editor, selectionIndex);
                if (bracketRange) {
                    needDimIndent = false;
                    HLRange[0] = new vscode.Range(0, 0, bracketRange.start.line, bracketRange.start.character);
                    HLRange[1] = new vscode.Range(bracketRange.end.line, bracketRange.end.character,
                        editor.document.lineCount, Number.MAX_VALUE);
                    lastRange = bracketRange
                } else if (dimmingReason === 'brackets') {
                    needDimIndent = false
                    HLRange = []
                    lastRange = null
                    undimEditor(editor);
                }
            }

            if (needDimIndent) {
                HLRange[0] = new vscode.Range(0, 0,
                    topLine.lineNumber - 1, Number.MAX_VALUE);
                HLRange[1] = new vscode.Range(botLine.lineNumber + 1, 0,
                    editor.document.lineCount, Number.MAX_VALUE);
                lastRange = new vscode.Range(topLine.lineNumber, 0, botLine.lineNumber, Number.MAX_VALUE)
            }
        }
    }

    // HLRange = new vscode.Range(startPosition, endPosition)
    // editor.setDecorations(dimDecoration, [new vscode.Range(startPosition, endPosition)]);
    editor.setDecorations(dimDecoration, HLRange);
}

function findTop(editor: vscode.TextEditor) {
    let line: vscode.TextLine = editor.document.lineAt(editor.selection.active);
    //If whitespace selected process closest nonwhitespace above it
    while (line.isEmptyOrWhitespace && line.lineNumber > 0) {
        line = editor.document.lineAt(line.lineNumber - 1);
    }
    if (line.lineNumber < editor.document.lineCount - 1 && !line.isEmptyOrWhitespace) {
        let nextLine = editor.document.lineAt(line.lineNumber + 1);
        // Find first nonwhitespace line
        while (nextLine.isEmptyOrWhitespace && nextLine.lineNumber < editor.document.lineCount - 1) {
            nextLine = editor.document.lineAt(nextLine.lineNumber + 1);
        }
    }
    let indentLevel = NaN;
    while (line.lineNumber > 0) {
        if (!line.isEmptyOrWhitespace) {
            let nextLevel = getIndentLevel(editor, line);
            if (Number.isNaN(indentLevel)) {
                indentLevel = nextLevel;
            }
            if (nextLevel === 0) {
                return line;
            }
            if (nextLevel < indentLevel) {
                return line;
            }
        }
        line = editor.document.lineAt(line.lineNumber - 1);
    }
    return line;
}

function findBot(editor: vscode.TextEditor, topLine: vscode.TextLine) {
    let line: vscode.TextLine = editor.document.lineAt(Math.min(editor.document.lineCount - 1, topLine.lineNumber + 1));
    let baseLevel = getIndentLevel(editor, editor.document.lineAt(editor.selection.active));
    while (line.lineNumber < editor.document.lineCount - 1) {
        if (!line.isEmptyOrWhitespace) {
            let nextLevel = getIndentLevel(editor, line);
            if (nextLevel < baseLevel || nextLevel === 0) {
                //if(nextLevel <= this.getIndentLevel(editor, topLine)){
                return line;
            }
        }
        line = editor.document.lineAt(line.lineNumber + 1);
    }
    return line;
}

/**
* Parses a line to get the indentation level manually
* Assumes line is already non-whitespace
* @param line Line to parse
* @returns Number of space-equivalents in the line
**/
function getIndentLevel(editor: vscode.TextEditor, line: vscode.TextLine) {
    // Deleet Cache block?
    //if(lineTable.has(line)){
    //   return lineTable.get(line);
    // }else{
    let indentLevel = line.firstNonWhitespaceCharacterIndex;
    let lineText = line.text;
    for (var i = 0; i < indentLevel; i++) {
        if (lineText.charAt(i) === '\t') {
            indentLevel += (TAB_SIZE - 1);
        }
    }
    lineTable.set(line, indentLevel);
    return indentLevel;

    // Cache block end
    // }
}

function changeActive() {
    setCurrentDocumentTabSize();
}

function setCurrentDocumentTabSize() {
    let editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }
    let tabs: number;
    tabs = editor.options.tabSize as number;
    TAB_SIZE = tabs;
}

/**
 * Finds the surrounding brackets and returns the range that encompasses them within the HLRange scope.
 * @param editor The text editor.
 * @param index The current selection index.
 * @param topOffset The top boundary for the search.
 * @param bottomOffset The bottom boundary for the search.
 * @returns A range that encompasses the brackets or null if no matching brackets are found.
 */
function findSurroundingBrackets(editor: vscode.TextEditor, index: number): vscode.Range | null {
    const text = editor.document.getText();

    let openingIndex = -1;
    let closingIndex = -1;
    const openingBrackets = { '(': ')', '{': '}', '[': ']', '<': '>' }
    const closingBrackets = { ')': '(', '}': '{', ']': '[', '>': '<' }
    let openingCount = { '(': 0, '{': 0, '[': 0, '<': 0 }
    let openingBracket = null;

    // Search backwards to find the first opening bracket within the topOffset limit
    for (let i = index; i >= 0; i--) {
        let char = text.charAt(i);
        if (openingBrackets[char] && i < index) {
            openingCount[char]++;
            if (openingCount[char] === 1) {
                openingBracket = char;
                openingIndex = i;
                break;
            }
        } else if (closingBrackets[char] && i < index) {
            openingCount[closingBrackets[char]]--;
        }
    }

    if (openingBracket === null) {
        return null; // No opening bracket found
    }

    // Search forwards to find the first closing bracket within the bottomOffset limit
    for (let i = index; i < text.length; i++) {
        let char = text.charAt(i);
        if (char === openingBracket) {
            openingCount[char]++;
        } else if (char === openingBrackets[openingBracket]) {
            openingCount[openingBracket]--;
            if (openingCount[openingBracket] === 0) {
                closingIndex = i;
                break;
            }
        }
    }

    if (openingCount[openingBracket] !== 0) {
        return null; // No closing bracket found
    }

    let startPosition = editor.document.positionAt(openingIndex);
    let endPosition = editor.document.positionAt(closingIndex + 1); // +1 to include the closing bracket
    return new vscode.Range(startPosition, endPosition);
}

function configureStatusBar(context: vscode.ExtensionContext) {
    statusBarButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarButton.command = 'dimmer.ToggleDimmer'; // Command to execute on click
    statusBarButton.tooltip = 'Click to toggle icon';
    statusBarButton.show();
    context.subscriptions.push(statusBarButton);
    updateStatusBarIcon()
}

function updateStatusBarIcon() {
    if (statusBarButton === null) { return }
    if (enabled) {
        statusBarButton.text = `$(check) Dim`; // Set to a check icon
    } else {
        statusBarButton.text = `$(x) Dim`; // Set to a cross icon
    }
}

export function deactivate() {
    resetAllDecorations();
}