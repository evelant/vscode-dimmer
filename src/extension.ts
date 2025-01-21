'use strict'

import * as vscode from 'vscode'
import * as utils from './utils'

let TAB_SIZE = 4

let enabled = false
let opacity = 50
let delay = 200
let commandScope = true
let HLRange: vscode.Range[] = []
let fixedRange: vscode.Range | undefined = undefined

let dimDecoration: vscode.TextEditorDecorationType;
let normalDecoration = vscode.window.createTextEditorDecorationType(<vscode.DecorationRenderOptions>{
    textDecoration: 'none; opacity: 1'
})

let lineTable = new Map() // Line dict

let delayers: { [key: string]: utils.ThrottledDelayer<void> } = Object.create(null)
let dimmingReason = 'indentAndBrackets'
let statusBarButton: vscode.StatusBarItem = null
let lastRange: vscode.Range = null

export function activate(context: vscode.ExtensionContext) {
    let configRegistration = vscode.workspace.onDidChangeConfiguration((e) => {
        initialize(context)
    })
    let selectionRegistration = vscode.window.onDidChangeTextEditorSelection((e) => {
        updateIfEnabled(e.textEditor, context);
    })
    let textEditorChangeRegistration = vscode.window.onDidChangeActiveTextEditor((e) => {
        updateIfEnabled(e, context);
    })
    let toggleCommandRegistration = vscode.commands.registerCommand('dimmer.ToggleDimmer', () => {
        vscode.workspace.getConfiguration('dimmer').update("enabled", !enabled, commandScope)
    })
    let fixCommandRegistration = vscode.commands.registerCommand('dimmer.FixDimmer', () => {
        if (fixedRange) {
            fixedRange = null
            setAllDecorations(context)
        } else {
            fixedRange = lastRange
        }
    })
    let expandCommandRegistration = vscode.commands.registerCommand('dimmer.ExpandDimmer', () => {
        if (vscode.window.activeTextEditor) {
            expandSelection(vscode.window.activeTextEditor, context)
        }
    })
    let shrinkCommandRegistration = vscode.commands.registerCommand('dimmer.SrinkDimmer', () => {
        if (vscode.window.activeTextEditor) {
            shrinkSelection(vscode.window.activeTextEditor, context)
        }
    })

    initialize(context)

    configureStatusBar(context)
    context.subscriptions.push(
        selectionRegistration,
        configRegistration,
        toggleCommandRegistration,
        fixCommandRegistration,
        textEditorChangeRegistration,
        expandCommandRegistration,
        shrinkCommandRegistration
    )

    vscode.commands.executeCommand('dimmer.FixDimmer').then(() => {
        console.log('FixDimmer command executed successfully')
    }, (err) => {
        console.error('Failed to execute FixDimmer command:', err)
    })
}

function updateIfEnabled(textEditor: vscode.TextEditor, context: vscode.ExtensionContext) {
    if (enabled) {
        setDecorations(textEditor, context)
    }
}

function initialize(context: vscode.ExtensionContext) {
    resetAllDecorations(context)

    readConfig()
    createDimDecorator()

    setAllDecorations(context)

    updateStatusBarIcon()
}

function readConfig() {
    let config = vscode.workspace.getConfiguration('dimmer')
    commandScope = config.get('toggleDimmerCommandScope', 'user') === 'user'
    enabled = commandScope 
        ? config.inspect("enabled")?.globalValue === true
        : config.get('enabled', false)
    opacity = config.get('opacity', 50)
    delay = config.get('delay', 200)
    delay = delay < 0 ? 0 : delay
    dimmingReason = config.get('dimmingReason', 'indentAndBrackets')
}

function resetAllDecorations(context: vscode.ExtensionContext) {
    vscode.window.visibleTextEditors.forEach(textEditor => {
        resetDecorations(textEditor, context)
    })
}

function resetDecorations(textEditor: vscode.TextEditor, context: vscode.ExtensionContext) {
    undimEditor(textEditor)
    updateGlobalState([], textEditor, context)
}

function setAllDecorations(context: vscode.ExtensionContext) {
    vscode.window.visibleTextEditors.forEach((e) => {
        updateIfEnabled(e, context)
    })
}

function setDecorations(textEditor: vscode.TextEditor, context: vscode.ExtensionContext) {
    let filename = textEditor.document.fileName
    let delayer = delayers[filename]
    if (!delayer) {
        delayer = new utils.ThrottledDelayer<void>(delay)
        delayers[filename] = delayer;
    }
    delayer.trigger(() => {
        return Promise.resolve().then(() => {
            dimEditor(textEditor, context)
        });
    }, delay)
}

function updateGlobalState(ranges: vscode.Range[], editor: vscode.TextEditor, context: vscode.ExtensionContext) {
    const key = 'dimmer.highlighted_ranges'
    let value = context.globalState.get(key) ?? {}
    value[vscode.workspace.name] = value[vscode.workspace.name] ?? {}
    value[vscode.workspace.name][editor.document.fileName] = ranges
    context.globalState.update(key, value)
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
    editor.setDecorations(dimDecoration, [])
}

function isItRoot(editor: vscode.TextEditor) {
    return (getIndentLevel(editor, editor.document.lineAt(editor.selection.active)) === 0
    && !editor.document.lineAt(editor.selection.active).isEmptyOrWhitespace && dimmingReason !== 'brackets')
}

function dimEditor(editor: vscode.TextEditor, context: vscode.ExtensionContext) {
    if (!dimDecoration || !editor.selection.isSingleLine) return;

    // If top level statement that doesn't start a block the entire file is in it's context
    if (!isItRoot(editor)) {
        lastRange = computeRange(editor)
    }
    decorateForLastRange(editor, context)
}

function computeRange(editor: vscode.TextEditor) {
    let topLine = findTop(editor, editor.document.lineAt(editor.selection.active))
    let botLine = findBot(editor, topLine, editor.selection.active)
    if (dimmingReason !== 'indent') {
        // Bracket-based dimming within the HLRange
        let selectionIndex = editor.document.offsetAt(editor.selection.active)
        let bracketRange = findSurroundingBrackets(editor, selectionIndex)
        if (bracketRange) {
            return bracketRange
        } else if (dimmingReason === 'brackets') {
            return null
        }
    } else {
        return new vscode.Range(topLine.lineNumber, 0, botLine.lineNumber, Number.MAX_VALUE)
    }
}

function decorateForLastRange(editor: vscode.TextEditor, context: vscode.ExtensionContext) {
    if (lastRange) {
        if (fixedRange && fixedRange.contains(lastRange)) {
            lastRange = fixedRange
        } else {
            fixedRange = null
        }

        let normalRange = lastRange
        if (dimmingReason !== 'brackets' && normalRange.end.line > normalRange.start.line) {
            normalRange = new vscode.Range(normalRange.start.line, 0, normalRange.end.line, normalRange.end.character)
        } 
        HLRange[0] = new vscode.Range(0, 0, normalRange.start.line, normalRange.start.character)
        HLRange[1] = new vscode.Range(normalRange.end.line, normalRange.end.character, editor.document.lineCount, Number.MAX_VALUE)

        editor.setDecorations(dimDecoration, HLRange)
        editor.setDecorations(normalDecoration, [normalRange])
        updateGlobalState([normalRange], editor, context)
    } else {
        HLRange = []
        fixedRange = null
        resetDecorations(editor, context)
    }
}

function findTop(editor: vscode.TextEditor, line: vscode.TextLine) {
    //If whitespace selected process closest nonwhitespace above it
    while (line.isEmptyOrWhitespace && line.lineNumber > 0) {
        line = editor.document.lineAt(line.lineNumber - 1)
    }
    if (line.lineNumber < editor.document.lineCount - 1 && !line.isEmptyOrWhitespace) {
        let nextLine = editor.document.lineAt(line.lineNumber + 1)
        // Find first nonwhitespace line
        while (nextLine.isEmptyOrWhitespace && nextLine.lineNumber < editor.document.lineCount - 1) {
            nextLine = editor.document.lineAt(nextLine.lineNumber + 1)
        }
    }
    let indentLevel = NaN
    while (line.lineNumber > 0) {
        if (!line.isEmptyOrWhitespace) {
            let nextLevel = getIndentLevel(editor, line)
            if (Number.isNaN(indentLevel)) {
                indentLevel = nextLevel
            }
            if (nextLevel === 0) {
                return line
            }
            if (nextLevel < indentLevel) {
                return line
            }
        }
        line = editor.document.lineAt(line.lineNumber - 1)
    }
    return line
}

function findBot(editor: vscode.TextEditor, topLine: vscode.TextLine, position: vscode.Position) {
    let line: vscode.TextLine = editor.document.lineAt(Math.min(editor.document.lineCount - 1, topLine.lineNumber + 1))
    let baseLevel = getIndentLevel(editor, editor.document.lineAt(position))
    while (line.lineNumber < editor.document.lineCount - 1) {
        if (!line.isEmptyOrWhitespace) {
            let nextLevel = getIndentLevel(editor, line)
            if (nextLevel < baseLevel || nextLevel === 0) {
                return line;
            }
        }
        line = editor.document.lineAt(line.lineNumber + 1)
    }
    return line
}

/**
* Parses a line to get the indentation level manually
* Assumes line is already non-whitespace
* @param line Line to parse
* @returns Number of space-equivalents in the line
**/
function getIndentLevel(editor: vscode.TextEditor, line: vscode.TextLine) {
    let indentLevel = line.firstNonWhitespaceCharacterIndex
    let lineText = line.text
    for (var i = 0; i < indentLevel; i++) {
        if (lineText.charAt(i) === '\t') {
            indentLevel += (TAB_SIZE - 1)
        }
    }
    lineTable.set(line, indentLevel)
    return indentLevel
}

function changeActive() {
    setCurrentDocumentTabSize()
}

function setCurrentDocumentTabSize() {
    let editor = vscode.window.activeTextEditor
    if (!editor) {
        return
    }
    let tabs: number
    tabs = editor.options.tabSize as number
    TAB_SIZE = tabs
}

function expandedSelection(selection: vscode.Range, editor: vscode.TextEditor, context: vscode.ExtensionContext) {
    if (dimmingReason !== 'indent') {
        // Try bracket expansion first
        const currentPos = editor.document.offsetAt(selection.start)
        const expandedRange = findSurroundingBrackets(editor, currentPos)
        
        if (expandedRange && !expandedRange.isEqual(selection)) {
            return expandedRange
        }
    }
    
    if (dimmingReason !== 'brackets') {
        // If brackets didn't work or we're in indent mode, try indent expansion
        const currentIndent = getIndentLevel(editor, editor.document.lineAt(selection.start.line))
        let line = editor.document.lineAt(selection.start.line)
        
        // Search upward for lower indent level
        while (line.lineNumber > 0) {
            line = editor.document.lineAt(line.lineNumber - 1)
            if (!line.isEmptyOrWhitespace) {
                const indent = getIndentLevel(editor, line)
                if (indent < currentIndent) {
                    const botLine = findBot(editor, line, editor.selection.active)
                    const newRange = new vscode.Range(line.lineNumber, 0, botLine.lineNumber, Number.MAX_VALUE)
                    if (!selection.isEqual(newRange)) {
                        return newRange
                    }
                }
            }
        }
    }
    return null
}

function expandSelection(editor: vscode.TextEditor, context: vscode.ExtensionContext) {
    if (isItRoot(editor)) { return }
    let highlighted = fixedRange ?? lastRange
    if (!highlighted) { return }
    const expanded = expandedSelection(highlighted, editor, context)
    if (expanded) {
        lastRange = expanded
        fixedRange = expanded
        decorateForLastRange(editor, context)
    }
}

function shrinkSelection(editor: vscode.TextEditor, context: vscode.ExtensionContext) {
    if (isItRoot(editor)) { return }
    let highlighted = fixedRange ?? lastRange
    if (!highlighted) { return }

    // Get current cursor position range
    let currentRange = computeRange(editor)
    if (!currentRange) { return }

    // If current range is smaller than highlighted and within it, use that
    if (currentRange.start.isAfterOrEqual(highlighted.start) && 
        currentRange.end.isBeforeOrEqual(highlighted.end) &&
        !currentRange.isEqual(highlighted)) {
        lastRange = currentRange
        fixedRange = currentRange
        decorateForLastRange(editor, context)
        return
    }

    // Otherwise try to find a range between current and highlighted
    let possibleRange = expandedSelection(currentRange, editor, context)
    while (possibleRange && !possibleRange.isEqual(highlighted)) {
        if (possibleRange.start.isAfterOrEqual(highlighted.start) && 
            possibleRange.end.isBeforeOrEqual(highlighted.end)) {
            lastRange = possibleRange
            fixedRange = possibleRange
            decorateForLastRange(editor, context)
            return
        }
        possibleRange = expandedSelection(possibleRange, editor, context)
    }
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
    const text = editor.document.getText()

    let openingIndex = -1
    let closingIndex = -1
    const openingBrackets = { '(': ')', '{': '}', '[': ']', '<': '>' }
    const closingBrackets = { ')': '(', '}': '{', ']': '[', '>': '<' }
    let openingCount = { '(': 0, '{': 0, '[': 0, '<': 0 }
    let openingBracket = null

    // Search backwards to find the first opening bracket within the topOffset limit
    for (let i = index; i >= 0; i--) {
        let char = text.charAt(i)
        if (openingBrackets[char] && i < index) {
            openingCount[char]++
            if (openingCount[char] === 1) {
                openingBracket = char
                openingIndex = i
                break;
            }
        } else if (closingBrackets[char] && i < index) {
            openingCount[closingBrackets[char]]--
        }
    }

    if (openingBracket === null) {
        return null; // No opening bracket found
    }

    // Search forwards to find the first closing bracket within the bottomOffset limit
    for (let i = index; i < text.length; i++) {
        let char = text.charAt(i)
        if (char === openingBracket) {
            openingCount[char]++
        } else if (char === openingBrackets[openingBracket]) {
            openingCount[openingBracket]--
            if (openingCount[openingBracket] === 0) {
                closingIndex = i
                break
            }
        }
    }

    if (openingCount[openingBracket] !== 0) {
        return null // No closing bracket found
    }

    let startPosition = editor.document.positionAt(openingIndex)
    let endPosition = editor.document.positionAt(closingIndex + 1) // +1 to include the closing bracket
    return new vscode.Range(startPosition, endPosition)
}

function configureStatusBar(context: vscode.ExtensionContext) {
    statusBarButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
    statusBarButton.command = 'dimmer.ToggleDimmer' // Command to execute on click
    statusBarButton.tooltip = 'Click to toggle icon'
    statusBarButton.show()
    context.subscriptions.push(statusBarButton)
    updateStatusBarIcon()
}

function updateStatusBarIcon() {
    if (statusBarButton === null) { return }
    if (enabled) {
        statusBarButton.text = `$(check) Dim` // Set to a check icon
    } else {
        statusBarButton.text = `$(x) Dim` // Set to a cross icon
    }
}

export function deactivate(context: vscode.ExtensionContext) {
    resetAllDecorations(context)
}
