// netlify/functions/run-code.js
export async function handler(event) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const input = JSON.parse(event.body || '{}');
    const language = normalizeLang(input.language);
    const version = input.version || 'latest';
    const stdin = input.stdin; // string 또는 string[]
    const files = Array.isArray(input.files) ? input.files : [];

    // === 단일 TU 번들링 (C/C++ 전용) ===
    let filesToSend = files;
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

// --- helpers ---

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

  const srcPred = lang === 'cpp' ? isCppSrc : isCSrc;

  const headers = files.filter(f => isHeader(f.name));
  const sources = files.filter(f => srcPred(f.name));

  if (sources.length === 0) {
    // 소스가 없으면 그대로 전달(헤더-only 데모)
    return files;
  }

  // main 후보: 파일명이 main.* 이면 우선, 없으면 내용에서 int main( ) 탐지
  const byName = sources.find(f => /^main\.(cpp|cc|cxx|c)$/i.test(f.name));
  const byBody = sources.find(f => hasMain(f.content));
  const main = byName || byBody || sources[0];
  const others = sources.filter(f => f !== main);

  const chunks = [];
  const push = f => {
    const content = f.content.endsWith('\n') ? f.content : (f.content + '\n');
    chunks.push(`#line 1 "${f.name}"\n${content}`);
  };

  headers.forEach(push);
  others.forEach(push);
  push(main);

  const bundledName = lang === 'cpp' ? 'main.cpp' : 'main.c';
  return [{ name: bundledName, content: chunks.join('\n') }];
}

function hasMain(code) {
  const noComments = code
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
    .replace(/\/\/.*$/gm, '');          // line comments
  return /\bint\s+main\s*\(/.test(noComments);
}
