import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE_PLOT_RE = /(^|[^.\w])(plot|plotshape|plotchar|plotarrow|barcolor)\s*\(/g;
const EXTRA_OUTPUT_RE = /(^|[^.\w])(bgcolor|plotcandle|plotbar)\s*\(/g;
const TA_OR_SEC_RE = /\b(ta\.[A-Za-z_]\w*|request\.security(?:_lower_tf)?)\s*\(/g;
const REQ_SEC_RE = /\brequest\.security(?:_lower_tf)?\s*\(/g;

function stripCommentsAndStrings(source) {
  const lines = source.split(/\r?\n/);
  const codeLines = [];
  const noCommentLines = [];
  const stringLiterals = [];

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const raw = lines[lineIdx];
    let codeOut = '';
    let noCommentOut = '';
    let inQuote = null;
    let litBuf = '';

    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      const next = raw[i + 1];

      if (inQuote) {
        noCommentOut += ch;
        if (ch === '\\' && next !== undefined) {
          litBuf += ch + next;
          noCommentOut += next;
          i++;
          continue;
        }
        if (ch === inQuote) {
          stringLiterals.push({ line: lineIdx + 1, value: litBuf });
          codeOut += inQuote;
          inQuote = null;
          litBuf = '';
        } else {
          litBuf += ch;
        }
        continue;
      }

      if (ch === '/' && next === '/') {
        break;
      }

      if (ch === '"' || ch === "'") {
        inQuote = ch;
        litBuf = '';
        codeOut += ch;
        noCommentOut += ch;
        continue;
      }

      codeOut += ch;
      noCommentOut += ch;
    }

    codeLines.push(codeOut);
    noCommentLines.push(noCommentOut);
  }

  return {
    lines,
    codeLines,
    noCommentLines,
    stringLiterals,
  };
}

function leadingIndent(line) {
  let count = 0;
  for (const ch of line) {
    if (ch === ' ') count += 1;
    else if (ch === '\t') count += 4;
    else break;
  }
  return count;
}

function updateParenDepth(text, depth) {
  let d = depth;
  for (const ch of text) {
    if (ch === '(' || ch === '[') d++;
    else if (ch === ')' || ch === ']') d = Math.max(0, d - 1);
  }
  return d;
}

function buildLogicalStatements(codeLines) {
  const statements = [];
  let current = null;
  let parenDepth = 0;

  for (let i = 0; i < codeLines.length; i++) {
    const line = codeLines[i];
    const trimmed = line.trim();
    const lineNo = i + 1;

    if (current) {
      current.text += '\n' + line;
      current.endLine = lineNo;
      parenDepth = updateParenDepth(line, parenDepth);
      if (parenDepth === 0 && !/[+\-*/,(?:=]$|\b(and|or)\s*$/.test(trimmed)) {
        statements.push(current);
        current = null;
      }
      continue;
    }

    if (!trimmed) continue;

    const indent = leadingIndent(line);
    parenDepth = updateParenDepth(line, 0);
    current = {
      startLine: lineNo,
      endLine: lineNo,
      indent,
      text: line,
    };

    if (parenDepth === 0 && !/[+\-*/,(?:=]$|\b(and|or)\s*$/.test(trimmed)) {
      statements.push(current);
      current = null;
    }
  }

  if (current) {
    statements.push(current);
  }
  return statements;
}

function extractBalancedCalls(codeText, regex) {
  const calls = [];
  regex.lastIndex = 0;
  let match;
  while ((match = regex.exec(codeText)) !== null) {
    const openIdx = codeText.indexOf('(', match.index);
    if (openIdx < 0) continue;
    let depth = 0;
    let endIdx = -1;
    for (let i = openIdx; i < codeText.length; i++) {
      const ch = codeText[i];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          endIdx = i;
          break;
        }
      }
    }
    const line = codeText.slice(0, match.index).split('\n').length;
    const body = endIdx >= 0 ? codeText.slice(openIdx + 1, endIdx) : codeText.slice(openIdx + 1);
    calls.push({ line, text: body, raw: codeText.slice(match.index, endIdx >= 0 ? endIdx + 1 : undefined) });
  }
  return calls;
}

function countRegexMatches(text, regex) {
  let count = 0;
  regex.lastIndex = 0;
  while (regex.exec(text) !== null) count++;
  return count;
}

function checkTopLevelTaAndSecurity(statements) {
  const violations = [];
  const blockStack = [];

  for (const stmt of statements) {
    const trimmed = stmt.text.trim();

    while (blockStack.length > 0) {
      const top = blockStack[blockStack.length - 1];
      if (stmt.indent > top.headerIndent) break;
      if (stmt.indent === top.headerIndent && (top.kind === 'if' || top.kind === 'else-if') && /^else\b/.test(trimmed)) {
        top.kind = /^else\s+if\b/.test(trimmed) ? 'else-if' : 'else';
        break;
      }
      blockStack.pop();
    }

    const inSwitch = blockStack.some(b => b.kind === 'switch');
    const opensControl = /^(if|else|for|while|switch)\b/.test(trimmed) ||
      /=\s*(if|switch|for|while)\b/.test(trimmed);
    const arrowIdx = stmt.text.indexOf('=>');
    const opensFunction = arrowIdx >= 0 && !inSwitch;

    TA_OR_SEC_RE.lastIndex = 0;
    let match;
    while ((match = TA_OR_SEC_RE.exec(stmt.text)) !== null) {
      const callName = match[1];
      const matchOffset = match.index;
      const lineOffset = stmt.text.slice(0, matchOffset).split('\n').length - 1;
      const callLine = stmt.startLine + lineOffset;
      const prefix = stmt.text.slice(0, matchOffset);

      if (blockStack.length > 0) {
        const outer = blockStack[blockStack.length - 1];
        violations.push(
          `L${callLine}: ${callName}() inside ${outer.kind} block (opened at L${outer.line}) — must run unconditionally at top-level scope`
        );
        continue;
      }

      if (stmt.indent > 0) {
        violations.push(
          `L${callLine}: ${callName}() at indent ${stmt.indent} — must run unconditionally at top-level scope`
        );
        continue;
      }

      if (opensControl) {
        violations.push(
          `L${callLine}: ${callName}() inside control-flow header statement — hoist to standalone unconditional top-level binding`
        );
        continue;
      }

      if (opensFunction && matchOffset > arrowIdx) {
        violations.push(
          `L${callLine}: ${callName}() inside function/method body — must run unconditionally at top-level scope`
        );
        continue;
      }

      if (/\?/.test(prefix)) {
        violations.push(
          `L${callLine}: ${callName}() inside ternary (? :) branch — must run unconditionally at top-level scope`
        );
        continue;
      }

      if (/\b(and|or)\b/.test(prefix)) {
        violations.push(
          `L${callLine}: ${callName}() on RHS of boolean short-circuit (and/or) — hoist to standalone unconditional top-level binding`
        );
        continue;
      }
    }

    if (opensControl) {
      const kindMatch = trimmed.match(/^(if|else|for|while|switch)\b/) || trimmed.match(/=\s*(if|switch|for|while)\b/);
      blockStack.push({
        kind: kindMatch ? kindMatch[1] : 'control',
        headerIndent: stmt.indent,
        line: stmt.startLine,
      });
    } else if (opensFunction) {
      const afterArrow = stmt.text.slice(arrowIdx + 2).trim();
      if (!afterArrow) {
        blockStack.push({
          kind: 'function',
          headerIndent: stmt.indent,
          line: stmt.startLine,
        });
      }
    }
  }

  return violations;
}

export function checkPineSource(source, fileLabel = '<memory>', options = {}) {
  const {
    maxPlots = 55,
    hardMaxPlots = 64,
    maxObjects = 500,
    maxHistoryLimit = 4500,
    requireStrategyCostConfig = true,
  } = options;

  const errors = [];
  const warnings = [];

  const { codeLines, noCommentLines, stringLiterals } = stripCommentsAndStrings(source);
  const codeText = codeLines.join('\n');
  const noCommentText = noCommentLines.join('\n');

  // 1. Pine Script v6 directive
  const hasV6 = /^\s*\/\/@version=6\b/m.test(source);
  const hasOlderVersion = /^\s*\/\/@version=[1-5]\b/m.test(source);
  if (!hasV6 || hasOlderVersion) {
    errors.push(`${fileLabel}: must declare //@version=6 (foundOlder=${hasOlderVersion})`);
  }

  // 2. Declaration (indicator or strategy) & object count caps
  const declCalls = [
    ...extractBalancedCalls(codeText, /(^|\n)\s*indicator\s*\(/g).map(c => ({ kind: 'indicator', ...c })),
    ...extractBalancedCalls(codeText, /(^|\n)\s*strategy\s*\(/g).map(c => ({ kind: 'strategy', ...c })),
  ];
  if (declCalls.length !== 1) {
    errors.push(`${fileLabel}: expected exactly 1 indicator(...) or strategy(...) declaration, found ${declCalls.length}`);
  }
  const decl = declCalls[0];
  const objectBounds = {};
  if (decl) {
    for (const field of ['max_boxes_count', 'max_lines_count', 'max_labels_count']) {
      const m = decl.text.match(new RegExp(`\\b${field}\\s*=\\s*(\\d+)`));
      if (!m) {
        errors.push(`${fileLabel}: ${decl.kind}(...) must explicitly set ${field} <= ${maxObjects}`);
      } else {
        const val = Number(m[1]);
        objectBounds[field] = val;
        if (!Number.isFinite(val) || val <= 0 || val > maxObjects) {
          errors.push(`${fileLabel}: ${field}=${val} exceeds limit ${maxObjects}`);
        }
      }
    }
    const barsBackMatch = decl.text.match(/\bmax_bars_back\s*=\s*(\d+)/);
    if (barsBackMatch) {
      const val = Number(barsBackMatch[1]);
      objectBounds.max_bars_back = val;
      if (val > 5000) {
        errors.push(`${fileLabel}: max_bars_back=${val} exceeds 5000`);
      }
    }

    if (decl.kind === 'strategy' && requireStrategyCostConfig) {
      for (const reqField of ['commission_type', 'commission_value', 'slippage']) {
        if (!new RegExp(`\\b${reqField}\\s*=`).test(decl.text)) {
          errors.push(`${fileLabel}: strategy(...) must configure ${reqField}`);
        }
      }
    }
  }

  // 3. HISTORY_LIMIT <= 4500 & mswindow cap
  const histMatch = codeText.match(/\bHISTORY_LIMIT\s*=\s*(\d+)/);
  let historyLimit = null;
  if (!histMatch) {
    errors.push(`${fileLabel}: must define HISTORY_LIMIT <= ${maxHistoryLimit}`);
  } else {
    historyLimit = Number(histMatch[1]);
    if (!Number.isFinite(historyLimit) || historyLimit <= 0 || historyLimit > maxHistoryLimit) {
      errors.push(`${fileLabel}: HISTORY_LIMIT=${historyLimit} exceeds ${maxHistoryLimit}`);
    }
  }
  const mswindowLine = codeLines.find(l => /\bint\s+mswindow\s*=/.test(l));
  if (mswindowLine) {
    const maxvalMatch = mswindowLine.match(/\bmaxval\s*=\s*(\d+)/);
    const defMatch = mswindowLine.match(/input\.int\s*\(\s*(\d+)/);
    if (!maxvalMatch || Number(maxvalMatch[1]) > maxHistoryLimit) {
      errors.push(`${fileLabel}: mswindow input must enforce maxval <= ${maxHistoryLimit}`);
    }
    if (defMatch && Number(defMatch[1]) > maxHistoryLimit) {
      errors.push(`${fileLabel}: mswindow default=${defMatch[1]} exceeds ${maxHistoryLimit}`);
    }
  }

  // 4. Plot counts <= 64 (and <= maxPlots target)
  const corePlots = countRegexMatches(codeText, CORE_PLOT_RE);
  const extraOutputs = countRegexMatches(codeText, EXTRA_OUTPUT_RE);
  const totalOutputs = corePlots + extraOutputs;
  if (corePlots > hardMaxPlots || totalOutputs > hardMaxPlots) {
    errors.push(`${fileLabel}: total plot calls (${corePlots} core + ${extraOutputs} extra = ${totalOutputs}) exceeds TradingView cap ${hardMaxPlots}`);
  }
  if (corePlots > maxPlots) {
    errors.push(`${fileLabel}: plot calls (${corePlots}) exceeds target budget ${maxPlots}`);
  }

  // 5. Lookahead discipline on all request.security calls
  if (/\bbarmerge\.lookahead_on\b/.test(noCommentText)) {
    errors.push(`${fileLabel}: forbidden barmerge.lookahead_on detected`);
  }
  const secCalls = extractBalancedCalls(codeText, REQ_SEC_RE);
  for (const call of secCalls) {
    if (!/\blookahead\s*=\s*barmerge\.lookahead_off\b/.test(call.text)) {
      errors.push(`${fileLabel}: L${call.line} request.security(...) missing explicit lookahead = barmerge.lookahead_off`);
    }
  }

  // 6. Top-level unconditional scope for all ta.* and request.security* calls
  const statements = buildLogicalStatements(codeLines);
  const scopeViolations = checkTopLevelTaAndSecurity(statements);
  for (const v of scopeViolations) {
    errors.push(`${fileLabel}: ${v}`);
  }

  // 7. No hardcoded symbol lock
  if (/\bticker\.standard\s*\(/.test(codeText)) {
    errors.push(`${fileLabel}: hardcoded ticker.standard(...) check detected — indicator/strategy must work across arbitrary standard symbols`);
  }
  if (/\bsyminfo\.(tickerid|ticker|root|prefix|basecurrency)\s*[!=]=|[!=]=\s*syminfo\.(tickerid|ticker|root|prefix|basecurrency)\b/.test(codeText)) {
    errors.push(`${fileLabel}: hardcoded syminfo comparison detected — remove symbol lock`);
  }
  if (/\bstr\.(contains|startswith|endswith)\s*\(\s*syminfo\./.test(codeText)) {
    errors.push(`${fileLabel}: hardcoded syminfo string filter detected — remove symbol lock`);
  }
  for (const lit of stringLiterals) {
    if (/^(?:[A-Z]+:)?(?:BTC|ETH|SOL|BNB|XRP)(?:USDT|USDC|USD)(?:\.P)?$/i.test(lit.value.trim())) {
      errors.push(`${fileLabel}: L${lit.line} hardcoded pair literal "${lit.value}" detected`);
    }
  }

  // 8. Confirmed-candle discipline
  if (!/\bbarstate\.isconfirmed\b/.test(codeText)) {
    errors.push(`${fileLabel}: must use barstate.isconfirmed for closed-candle state updates and signal emission`);
  }

  return {
    file: fileLabel,
    pass: errors.length === 0,
    declaration: decl?.kind ?? null,
    corePlotCalls: corePlots,
    extraOutputCalls: extraOutputs,
    totalPlotCalls: totalOutputs,
    requestSecurityCalls: secCalls.length,
    historyLimit,
    objectBounds,
    errors,
    warnings,
  };
}

export function checkPineFiles(filePaths, options = {}) {
  const reports = [];
  for (const filePath of filePaths) {
    const abs = path.resolve(filePath);
    if (!fs.existsSync(abs)) {
      reports.push({
        file: filePath,
        pass: false,
        errors: [`${filePath}: file does not exist`],
        warnings: [],
      });
      continue;
    }
    const source = fs.readFileSync(abs, 'utf8');
    reports.push(checkPineSource(source, filePath, options));
  }
  return {
    pass: reports.every(r => r.pass),
    reports,
  };
}

function parseCliArgs(argv) {
  const files = [];
  let maxPlots = 55;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--max-plots') {
      maxPlots = Number(argv[++i]);
    } else {
      files.push(arg);
    }
  }
  return {
    files: files.length > 0 ? files : ['TOOL.pine', 'TOOL_Strategy.pine'],
    maxPlots,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { files, maxPlots } = parseCliArgs(process.argv.slice(2));
  const result = checkPineFiles(files, { maxPlots });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.pass ? 0 : 1);
}
