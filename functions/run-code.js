// netlify/functions/run-code.js
export async function handler(event) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  try {
    const input = JSON.parse(event.body || '{}');
    const language = normalizeLang(input.language);
    const version = input.version || 'latest';
    const stdin = input.stdin;
    const files = Array.isArray(input.files) ? input.files : [];

    let filesToSend = files;

    // C/C++: 다중 파일이면 단일 TU로 번들 + #include "..." 인라인
    if ((language === 'cpp' || language === 'c') && files.length > 1) {
      filesToSend = bundleToSingleTU(language, files);
    }

    const res = await fetch('https://onecompiler-apis.p.rapidapi.com/api/v1/run', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-RapidAPI-Key': process.env.ONECOMPILER_API_KEY,
        'X-RapidAPI-Host': 'onecompiler-apis.p.rapidapi.com'
      },
      body: JSON.stringify({
        language,
        version,
        files: filesToSend,
        ...(stdin !== undefined ? { stdin } : {})
      })
    });

    const data = await res.json();
    return { statusCode: 200, headers: cors, body: JSON.stringify(data) };
  } catch (error) {
    return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: error.message }) };
  }
}

/* ---------------- helpers ---------------- */

function normalizeLang(l) {
  const s = String(l || '').toLowerCase();
  if (['c++', 'cpp', 'cxx', 'cc'].includes(s)) return 'cpp';
  if (s === 'c') return 'c';
  return s;
}

function bundleToSingleTU(lang, files) {
  const isHeader = n => /\.(h|hh|hpp|hxx)$/i.test(n);
  const isCppSrc = n => /\.(cpp|cc|cxx)$/i.test(n);
  const isCSrc   = n => /\.c$/i.test(n);
  const srcPred  = (lang === 'cpp') ? isCppSrc : isCSrc;

  const mapByExact = new Map(files.map(f => [f.name, f]));
  const mapByBase  = new Map(files.map(f => [basename(f.name), f]));

  const lookup = (inc) => mapByExact.get(inc) || mapByBase.get(basename(inc)) || null;

  // main 후보: 파일명이 main.* 이면 우선, 아니면 내용에서 int main( ) 탐지
  const sources = files.filter(f => srcPred(f.name));
  const mainByName = sources.find(f => /^main\.(cpp|cc|cxx|c)$/i.test(f.name));
  const mainByBody = sources.find(f => hasMain(f.content));
  const main = mainByName || mainByBody || sources[0];

  const others = sources.filter(f => f !== main);

  // --- "따옴표 include" 인라인 ---
  const expanded = (file) => expandIncludes(file.name, file.content, lookup);

  // 헤더는 x(이미 인라인되므로 중복 방지)
  const chunks = [];
  const pushChunk = (name, body) => {
    const content = body.endsWith('\n') ? body : (body + '\n');
    chunks.push(`#line 1 "${name}"\n${content}`);
  };

  others.forEach(f => pushChunk(f.name, expanded(f)));
  if (main) pushChunk(main.name, expanded(main));

  const bundledName = (lang === 'cpp') ? 'main.cpp' : 'main.c';
  return [{ name: bundledName, content: chunks.join('\n') }];
}

function expandIncludes(originName, code, lookup, depth = 0, stack = new Set()) {
  if (depth > 32) return `/* include depth limit exceeded at ${originName} */\n` + code;

  // 실 include 패턴만 치환
  const includeRE = /^[ \t]*#[ \t]*include[ \t]*"([^"]+)"[^\n]*$/gm;

  let out = '';
  let last = 0;
  let m;

  while ((m = includeRE.exec(code)) !== null) {
    out += code.slice(last, m.index);
    const incName = m[1];
    const target = lookup(incName);

    if (target) {
      // 순환 방지
      const key = target.name;
      if (stack.has(key)) {
        out += `/* skipped recursive include "${key}" */\n`;
      } else {
        const nested = expandIncludes(
          target.name,
          target.content,
          lookup,
          depth + 1,
          new Set([...stack, key])
        );
        out += `\n// === begin include ${key} ===\n#line 1 "${key}"\n${nested}\n// === end include ${key} ===\n#line 1 "${originName}"\n`;
      }
    } else {
      // 프로젝트에 없는 파일이면 원문 유지 -> 실제 파일이 없으면 그대로 오류를 내게 함
      out += code.slice(m.index, includeRE.lastIndex);
    }

    last = includeRE.lastIndex;
  }
  out += code.slice(last);
  return out;
}

function hasMain(code) {
  const noBlock = code.replace(/\/\*[\s\S]*?\*\//g, '');
  const noLine  = noBlock.replace(/\/\/.*$/gm, '');
  return /\bint\s+main\s*\(/.test(noLine);
}

function basename(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return (i >= 0) ? p.slice(i + 1) : p;
}
