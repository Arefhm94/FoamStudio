import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.languages.registerDocumentSymbolProvider(
            { scheme: 'file', language: 'openfoam' },
            new OpenFOAMSymbolProvider()
        )
    );
}

class OpenFOAMSymbolProvider implements vscode.DocumentSymbolProvider {
    // Pre-compile all regex patterns
    private static readonly EDGES_REGEX = /^(edges|faces|points|internalField|boundary)\s*(\{|$|;)/i;
    private static readonly NAMED_BLOCK_REGEX = /^([a-zA-Z][\w]*)\s*(\{|$)/;
    private static readonly LIST_REGEX = /^(\w+)\s*\($/;
    private static readonly DICT_REGEX = /^(\w+)\s+\[([^\]]+)\]\s*;/;
    private static readonly KV_REGEX = /^([a-zA-Z][\w.]*)\s+([^;{}]+);/;
    
    provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
        const symbols: vscode.DocumentSymbol[] = [];
        const stack: { symbol: vscode.DocumentSymbol, indent: number }[] = [];

        const pushSymbol = (symbol: vscode.DocumentSymbol, indent: number) => {
            while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
                stack.pop();
            }
            if (stack.length > 0) {
                stack[stack.length - 1].symbol.children.push(symbol);
            } else {
                symbols.push(symbol);
            }
            stack.push({ symbol, indent });
        };

        // Helper function to find matching closing bracket
        const findClosingBracket = (startLine: number, openChar: string, closeChar: string, 
                                   initialCount: number = 0): number => {
            let open = initialCount;
            
            for (let j = startLine; j < document.lineCount; j++) {
                const line = document.lineAt(j).text;
                
                // Initial bracket on a separate line
                if (open === 0 && line.trim() === openChar) {
                    open = 1;
                    continue;
                }
                // Handle opening brackets on a line that starts with one
                if (open === 0 && line.trim().startsWith(openChar)) {
                    open = 1;
                }
                
                // Count brackets
                const openMatches = (line.match(new RegExp('\\' + openChar, 'g')) || []).length;
                const closeMatches = (line.match(new RegExp('\\' + closeChar, 'g')) || []).length;
                open += openMatches;
                open -= closeMatches;
                
                if (open === 0) {
                    return j;
                }
            }
            return document.lineCount - 1; // Default to last line if no match
        };

        for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i);
            const text = line.text.trim();
            const indent = line.firstNonWhitespaceCharacterIndex;

            if (text === '' || text.startsWith('//') || text.startsWith('/*')) continue;

            let match: RegExpMatchArray | null;
            let symbol: vscode.DocumentSymbol | null = null;
            
            // Special case for edges and other common keywords
            if ((match = text.match(OpenFOAMSymbolProvider.EDGES_REGEX))) {
                const name = match[1];
                
                if (text.endsWith(';') && !text.includes('{')) continue;
                
                const endLine = findClosingBracket(i + 1, '{', '}', text.includes('{') ? 1 : 0);
                
                symbol = new vscode.DocumentSymbol(
                    name,
                    name,
                    vscode.SymbolKind.Struct,
                    new vscode.Range(line.range.start, document.lineAt(endLine).range.end),
                    line.range
                );
            }
            // Named block with {
            else if ((match = text.match(OpenFOAMSymbolProvider.NAMED_BLOCK_REGEX))) {
                const name = match[1];
                
                // Quick check if this is just a name without a block
                if (!text.includes('{')) {
                    let foundOpeningBrace = false;
                    for (let j = i + 1; j < Math.min(i + 5, document.lineCount); j++) {
                        const nextLine = document.lineAt(j).text.trim();
                        if (nextLine === '{' || nextLine.startsWith('{')) {
                            foundOpeningBrace = true;
                            break;
                        }
                        if (nextLine !== '' && !nextLine.startsWith('//') && !nextLine.startsWith('/*')) {
                            break;
                        }
                    }
                    if (!foundOpeningBrace) continue;
                }
                
                const endLine = findClosingBracket(i + 1, '{', '}', text.includes('{') ? 1 : 0);
                
                // Determine the appropriate symbol kind
                let symbolKind = vscode.SymbolKind.Object;
                let detail = 'block';
                
                if (['boundary', 'faces', 'points', 'edges', 'internalField'].includes(name)) {
                    symbolKind = vscode.SymbolKind.Struct;
                    detail = name;
                } else if (['frontAndBack', 'inlet', 'outlet', 'walls', 'symmetry'].includes(name)) {
                    symbolKind = vscode.SymbolKind.Interface;
                    detail = 'boundary';
                }
                
                symbol = new vscode.DocumentSymbol(
                    name, 
                    detail,
                    symbolKind,
                    new vscode.Range(line.range.start, document.lineAt(endLine).range.end),
                    line.range
                );
            }
            // List block
            else if ((match = text.match(OpenFOAMSymbolProvider.LIST_REGEX))) {
                const name = match[1];
                const endLine = findClosingBracket(i + 1, '(', ')', 1);
                
                symbol = new vscode.DocumentSymbol(
                    name,
                    'list',
                    vscode.SymbolKind.Array,
                    new vscode.Range(line.range.start, document.lineAt(endLine).range.end),
                    line.range
                );
            }
            // FoamFile header
            else if (text === 'FoamFile') {
                let endLine = i;
                if (text.includes('{')) {
                    endLine = findClosingBracket(i + 1, '{', '}', 1);
                } else {
                    // Look ahead for opening brace
                    for (let j = i + 1; j < document.lineCount; j++) {
                        if (document.lineAt(j).text.includes('{')) {
                            endLine = findClosingBracket(j, '{', '}', 0);
                            break;
                        }
                        if (document.lineAt(j).text.trim() !== '' && 
                            !document.lineAt(j).text.trim().startsWith('//')) break;
                    }
                }
                
                symbol = new vscode.DocumentSymbol(
                    "FoamFile",
                    "header",
                    vscode.SymbolKind.File,
                    new vscode.Range(line.range.start, document.lineAt(endLine).range.end),
                    line.range
                );
            }
            // Dictionary assignment
            else if ((match = text.match(OpenFOAMSymbolProvider.DICT_REGEX))) {
                symbol = new vscode.DocumentSymbol(
                    match[1],
                    `[${match[2].trim()}]`,
                    vscode.SymbolKind.Constant,
                    line.range,
                    line.range
                );
            }
            // Key-value attribute
            else if ((match = text.match(OpenFOAMSymbolProvider.KV_REGEX))) {
                const name = match[1];
                const value = match[2].trim();
                
                // Determine symbol kind
                let symbolKind = vscode.SymbolKind.Property;
                if (name === 'class' || name === 'object') {
                    symbolKind = vscode.SymbolKind.Class;
                } else if (name === 'version' || name === 'format') {
                    symbolKind = vscode.SymbolKind.Constant;
                } else if (name === 'location') {
                    symbolKind = vscode.SymbolKind.File;
                }
                
                symbol = new vscode.DocumentSymbol(
                    name,
                    value,
                    symbolKind,
                    line.range,
                    line.range
                );
            }
            
            if (symbol) {
                pushSymbol(symbol, indent);
            }
        }

        return symbols;
    }
}
