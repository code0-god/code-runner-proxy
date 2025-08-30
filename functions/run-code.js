// netlify/functions/run-code.js
// C/C++ 다중 파일 → 단일 TU 번들 + "#include "..." 인라인" 서버 사이드 처리
// - 헤더 중복 인라인 방지(seen)
// - #pragma once 제거(경고/중복정의 예방)
// - #line 유지(진단 위치 원본 파일 기준)
// - 재귀/순환 include 가드(depth/stack)

export async function handler(event) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  // Preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const input = JSON.parse(event.body || '{}');
    const language = normalizeLang(input.language);
    const version  = input.version || 'latest';
    const stdin    = input.stdin;
    const files    = Array.isArray(input.files) ? input.files : [];

    let filesToSend = files;

    // C/C++: 파일이 2개 이상이면 단일 TU로 번들(헤더 인라인 포함)
    if ((language === 'cpp' || language === 'c') && files.length > 1) {
      try {
        filesToSend = bundleToSingleTU(language, files);
      } catch (e) {
        // 번들 실패 시 원본 그대로 전달(최소한 실행 시도는 하도록)
        console.warn('[run-code] bundleToSingleTU failed:', e);
        filesToSend = files;
      }
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
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: error.message })
    };
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
  const isSrc    = (lang === 'cpp') ? isCppSrc : isCSrc;

  // name 전체경로, basename 두 가지 키로 조회 지원
  const mapByExact = new Map(files.map(f => [f.name, f]));
  const mapByBase  = new Map(files.map(f => [basename(f.name), f]));
  const lookup = (inc) => mapByExact.get(inc) || mapByBase.get(basename(inc)) || null;

  // 소스 파일 수집 + main 후보 선정(파일명이 main.* 우선, 없으면 본문에 int main( ) 탐지)
  const sources = files.filter(f => isSrc(f.name));
  if (sources.length === 0) {
    // 소스가 없으면(헤더만) 그냥 합쳐서 단일 cpp/c로 보냄
    const bundledName = (lang === 'cpp') ? 'main.cpp' : 'main.c';
    const content = files.map(f => `// --- ${f.name} ---\n${f.content}\n`).join('\n');
    return [{ name: bundledName, content }];
  }

  const mainByName = sources.find(f => /^main\.(cpp|cc|cxx|c)$/i.test(f.name));
  const mainByBody = sources.find(f => hasMain(f.content));
  const main = mainByName || mainByBody || sources[0];
  const others = sources.filter(f => f !== main);

  // 전역 dedupe: 같은 헤더가 여러 소스에서 포함돼도 최초 1회만 인라인
  const seen = new Set();

  // 실 인라인 함수
  const expanded = (file) =>
    expandIncludes(file.name, file.content, lookup, {
      depth: 0,
      stack: [],
      seen,
      maxDepth: 32
    });

  const chunks = [];
  const push = (name, body) => {
    const content = body.endsWith('\n') ? body : (body + '\n');
    chunks.push(`#line 1 "${name}"\n${content}`);
  };

  // 헤더는 직접 끼워넣지 않음(각 소스 확장 시 인라인되므로 중복 제거에 유리)
  // 순서: other sources -> main
  others.forEach(f => push(f.name, expanded(f)));
  push(main.name, expanded(main));

  const bundledName = (lang === 'cpp') ? 'main.cpp' : 'main.c';
  return [{ name: bundledName, content: chunks.join('\n\n') }];
}

function expandIncludes(originName, code, lookup, ctx) {
  const { maxDepth = 32 } = ctx;
  if (ctx.depth > maxDepth) {
    return `/* include depth limit exceeded at ${originName} */\n` + code;
  }

  // "따옴표 include"만 인라인 처리. <...> 표준 헤더는 그대로 둠.
  const includeRE = /^[ \t]*#[ \t]*include[ \t]*"([^"]+)"[^\n]*$/gm;

  let out = '';
  let last = 0;
  let m;

  while ((m = includeRE.exec(code)) !== null) {
    out += code.slice(last, m.index);

    const incName = m[1];
    const target = lookup(incName);

    if (target) {
      const key = target.name;

      if (ctx.stack.includes(key)) {
        // 순환 include 방지
        out += `/* skipped recursive include "${key}" */\n`;
      } else if (ctx.seen.has(key)) {
        // 이미 인라인한 헤더는 스킵
        out += `/* skipped duplicate include "${key}" */\n`;
      } else {
        ctx.seen.add(key);

        // pragma once는 경고만 유발하므로 제거(라인 단위, 전역)
        let body = String(target.content)
          .replace(/^[ \t]*#\s*pragma\s+once[^\n]*\n?/gmi, '');

        const nested = expandIncludes(
          target.name,
          body,
          lookup,
          { ...ctx, depth: ctx.depth + 1, stack: [...ctx.stack, key] }
        );

        out += `\n// === begin include ${key} ===\n#line 1 "${key}"\n${nested}\n// === end include ${key} ===\n#line 1 "${originName}"\n`;
      }
    } else {
      // 프로젝트 내에 없는 파일이면 원문 유지(실제 컴파일러 오류로 자연스럽게 이어지도록)
      out += code.slice(m.index, includeRE.lastIndex);
    }

    last = includeRE.lastIndex;
  }

  out += code.slice(last);
  return out;
}

function hasMain(code) {
  // 주석 제거 후 int main( ) 탐지
  const noBlock = String(code).replace(/\/\*[\s\S]*?\*\//g, '');
  const noLine  = noBlock.replace(/\/\/.*$/gm, '');
  return /\bint\s+main\s*\(/.test(noLine);
}

function basename(p) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return (i >= 0) ? s.slice(i + 1) : s;
}
