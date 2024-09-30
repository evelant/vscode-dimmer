'use strict';

import * as vscode from 'vscode';
import * as utils from './utils';

let TAB_SIZE = 4;

let enabled = false;
let context = 0;
let opacity = 50;
let delay = 200;
let commandScope = true;
let HLRange: vscode.Range[] = [];

let dimDecoration: vscode.TextEditorDecorationType;
let normalDecoration = vscode.window.createTextEditorDecorationType(<vscode.DecorationRenderOptions> {
    textDecoration: 'none; opacity: 1'
});

let lineTable = new Map(); // Line dict

let delayers: { [key: string]: utils.ThrottledDelayer<void> } = Object.create(null);
let dimmingReason = 'indentAndBrackets'

export function activate(context: vscode.ExtensionContext) {
    console.log('activating the dimmer extension')
    let configRegistration           = vscode.workspace.onDidChangeConfiguration(initialize);
    let selectionRegistration        = vscode.window.onDidChangeTextEditorSelection((e) => updateIfEnabled(e.textEditor));
    let textEditorChangeRegistration = vscode.window.onDidChangeActiveTextEditor(updateIfEnabled);
    let commandRegistration          = vscode.commands.registerCommand('dimmer.ToggleDimmer', () => {
        console.log('toggling activation to', !enabled);
        vscode.workspace.getConfiguration('dimmer').update("enabled", !enabled, commandScope);
    });

    initialize();

    context.subscriptions.push(selectionRegistration, configRegistration, commandRegistration, textEditorChangeRegistration);
}

function updateIfEnabled(textEditor: vscode.TextEditor) {
    console.log('updated if enabled=', enabled)
    if (enabled) {
        setDecorations(textEditor);
    }
}

function initialize()  {
    resetAllDecorations();

    readConfig();
    createDimDecorator();

    setAllDecorations();
}

function readConfig() {
    let config = vscode.workspace.getConfiguration('dimmer');
    enabled = config.get('enabled', false);
    commandScope = config.get('toggleDimmerCommandScope', 'user') === 'user';
    opacity = config.get('opacity', 50);
    context = config.get('context', 0);
    delay = config.get('delay', 200);
    delay = delay < 0 ? 0 : delay;
    dimmingReason = config.get('dimmingReason', 'indentAndBrackets');
}

function resetAllDecorations() {
    vscode.window.visibleTextEditors.forEach(textEditor => {
        resetDecorations(textEditor);
    });
}

function resetDecorations(textEditor: vscode.TextEditor) {
    highlightSelections(textEditor, []);
    undimEditor(textEditor);
}

function setAllDecorations() {
    vscode.window.visibleTextEditors.forEach(updateIfEnabled);
}

function setDecorations(textEditor: vscode.TextEditor) {
    let filename = textEditor.document.fileName;
    let delayer = delayers[filename];
    if (!delayer) {
        delayer = new utils.ThrottledDelayer<void>(delay);
        delayers[filename] = delayer;
    }
    delayer.trigger(() => {
        return Promise.resolve().then(() => {
            console.log('setting decorations after delay')
            dimEditor(textEditor);
            if (dimmingReason === 'indent') {
                highlightSelections(textEditor, textEditor.selections);
            }
        });
    }, delay);
}

function highlightSelections(editor: vscode.TextEditor, selections: vscode.Range[]) {
    if (!normalDecoration) return;

    let ranges: vscode.Range[] = [];
    selections.forEach(s => {
        if (context < 0) {
            ranges.push(s);
        }
        else {
            ranges.push(new vscode.Range(
                new vscode.Position(Math.max(s.start.line - context, 0), 0),
                new vscode.Position(s.end.line + context, Number.MAX_VALUE)
            ));
        }
    });
    editor.setDecorations(normalDecoration, ranges);
}

function createDimDecorator() {
    if (dimDecoration) {
        dimDecoration.dispose();
    }
    dimDecoration = vscode.window.createTextEditorDecorationType(<vscode.DecorationRenderOptions> {
        textDecoration: `none; opacity: ${opacity / 100}`
    });
}

function undimEditor(editor: vscode.TextEditor) {
    if (!dimDecoration) return;

    editor.setDecorations(dimDecoration, []);
}

function dimEditor(editor: vscode.TextEditor) {
    console.log('Dimming now!')
    if (!dimDecoration) return;

    // TODO: change this to detect scope as other extension does
    let startPosition = new vscode.Position(0, 0)
    let endPosition = new vscode.Position(editor.document.lineCount, Number.MAX_VALUE);


    if(editor.selection.isSingleLine){
        let topLine = findTop(editor);
        let botLine = findBot(editor, topLine);
        // let HLRange : vscode.Range;

        console.log('topLine:', topLine);
        console.log('botLine:', botLine);

        // If top level statement that doesn't start a block the entire file is in it's context
        // if(editor.document.lineAt(editor.selection.active).firstNonWhitespaceCharacterIndex === 0
        if(getIndentLevel(editor, editor.document.lineAt(editor.selection.active)) === 0
            && !editor.document.lineAt(editor.selection.active).isEmptyOrWhitespace && dimmingReason === 'indent'){
            // Do nothing for now
            // this.unhighlightAll(editor);
            console.log('doing nothing')
        }else{
            // HLRange = new vscode.Range(topLine.lineNumber,0 ,
                // botLine.lineNumber, Number.MAX_VALUE);

            console.log('else clause')

            let needDimIndent = true;
            if (dimmingReason !== 'indent') {
                // Bracket-based dimming within the HLRange
                console.log('looking for brackets') 
                let selectionIndex = editor.document.offsetAt(editor.selection.active);
                let bracketRange = findSurroundingBrackets(editor, selectionIndex);
                if (bracketRange) {
                    needDimIndent = false;
                    HLRange[0] = new vscode.Range(0, 0, bracketRange.start.line, bracketRange.start.character);
                    HLRange[1] = new vscode.Range(bracketRange.end.line, bracketRange.end.character,
                        editor.document.lineCount, Number.MAX_VALUE);
                } else if (dimmingReason === 'brackets') {
                    needDimIndent = false
                    HLRange = []
                    undimEditor(editor);
                }
           }

           if (needDimIndent) {
                HLRange[0] = new vscode.Range(0, 0,
                    topLine.lineNumber - 1, Number.MAX_VALUE);
                console.log('first range')
                HLRange[1] = new vscode.Range(botLine.lineNumber + 1, 0,
                    editor.document.lineCount, Number.MAX_VALUE);
            }
            console.log('HLRange:', HLRange)
        }
    }

    // HLRange = new vscode.Range(startPosition, endPosition)

    console.log('setting range to:', HLRange)
    // editor.setDecorations(dimDecoration, [new vscode.Range(startPosition, endPosition)]);
    editor.setDecorations(dimDecoration, HLRange);
}

function findTop(editor :vscode.TextEditor){
    let line : vscode.TextLine = editor.document.lineAt(editor.selection.active);
    //If whitespace selected process closest nonwhitespace above it
    while(line.isEmptyOrWhitespace && line.lineNumber > 0){
        line = editor.document.lineAt(line.lineNumber - 1);
    }
    if(line.lineNumber < editor.document.lineCount - 1 && !line.isEmptyOrWhitespace){
        let nextLine = editor.document.lineAt(line.lineNumber + 1);
        // Find first nonwhitespace line
        while(nextLine.isEmptyOrWhitespace && nextLine.lineNumber < editor.document.lineCount - 1){
            nextLine = editor.document.lineAt(nextLine.lineNumber + 1);
        }
    }
    let indentLevel = NaN;
    while(line.lineNumber > 0){
        if(!line.isEmptyOrWhitespace){
            let nextLevel = getIndentLevel(editor,line);
            if(Number.isNaN(indentLevel)){
                indentLevel = nextLevel;
            }
            if(nextLevel === 0){
                return line;
            }
            if(nextLevel < indentLevel){
                return line;
            }
        }
        line = editor.document.lineAt(line.lineNumber - 1);
    }
    return line;
}

function findBot(editor : vscode.TextEditor, topLine : vscode.TextLine){
    let line : vscode.TextLine = editor.document.lineAt(topLine.lineNumber + 1);
    let baseLevel = getIndentLevel(editor, editor.document.lineAt(editor.selection.active));
    while(line.lineNumber < editor.document.lineCount - 1){
        if(!line.isEmptyOrWhitespace){
            let nextLevel = getIndentLevel(editor, line);
            if(nextLevel < baseLevel || nextLevel === 0){
            //if(nextLevel <= this.getIndentLevel(editor, topLine)){
                return line;
            }
        }
        line = editor.document.lineAt(line.lineNumber + 1);
    }
    console.log("EOF Reached");
    return line;
}

/**
* Parses a line to get the indentation level manually
* Assumes line is already non-whitespace
* @param line Line to parse
* @returns Number of space-equivalents in the line
**/
function getIndentLevel(editor: vscode.TextEditor, line : vscode.TextLine){
   // Deleet Cache block?
   //if(lineTable.has(line)){
   //   return lineTable.get(line);
   // }else{
   let indentLevel = line.firstNonWhitespaceCharacterIndex;
   let lineText = line.text;
   for(var i = 0; i < indentLevel; i++){
       if(lineText.charAt(i) === '\t'){
           indentLevel+= (TAB_SIZE - 1);
       }
   }
   lineTable.set(line, indentLevel);
   return indentLevel;

   // Cache block end
   // }
}

function changeActive(){
    console.log("Active Window Changed");
    setCurrentDocumentTabSize();
}

function setCurrentDocumentTabSize(){
    let editor = vscode.window.activeTextEditor;
    if(!editor){
        return;
    }
    let tabs : number;
    tabs = editor.options.tabSize as number;
    TAB_SIZE = tabs;
    console.log("Tab size of current document: " + TAB_SIZE);
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
    const openingBrackets = {'(': ')', '{': '}', '[': ']', '<': '>'}
    const closingBrackets = {')': '(', '}': '{', ']': '[', '>': '<'}
    let openingCount = {'(': 0, '{': 0, '[': 0, '<': 0}
    let openingBracket = null;

    console.log('Starting bracket search:', index, text.charAt(index));
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

export function deactivate() {
    resetAllDecorations();
}