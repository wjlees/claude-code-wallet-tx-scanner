#!/usr/bin/env node
/**
 * BTC/BCH UTXO 스캔 테스트 — wallet-tx-scanner 의 UTXO 스캔(§15)·unspents(§17) 로직 미러.
 * 실제 스캐너가 어떤 행(수신/출금/fee/unspents)을 만들지 노드에 붙여 미리 확인한다.
 *
 * 사용 (Node 18+, 의존성 없음):
 *   node btc-utxo-scan-test.mjs <rpcUrl> [옵션]
 *     rpcUrl        예: http://user:pass@127.0.0.1:8332
 *   옵션:
 *     --height N    스캔 시작 블록 (기본: tip)
 *     --blocks N    스캔 블록 수 (기본: 1)
 *     --addr a,b    감시 주소 지정 (기본: 자동 표본 — 첫 블록에서 vout 수신자 1명 + vin 소유자 1명 선택)
 *     --verbosity V 2|3 강제 (기본: 3 시도 → 실패 시 2 로 fallback + vin 마다 getrawtransaction)
 *
 * 예:
 *   node btc-utxo-scan-test.mjs http://user:pass@127.0.0.1:8332                  # tip 1블록 자동 표본
 *   node btc-utxo-scan-test.mjs http://user:pass@host:8332 --height 850000 --blocks 3 --addr bc1q...,bc1q...
 */

const [rawUrl, ...rest] = process.argv.slice(2);
if (!rawUrl) {
  console.error('usage: node btc-utxo-scan-test.mjs <rpcUrl> [--height N] [--blocks N] [--addr a,b] [--verbosity 2|3]');
  process.exit(1);
}
const opt = (name, dflt) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : dflt;
};

// --- 저수준 RPC (UtxoRpcClient 미러: URL 자격증명 → Basic 헤더) ---
const u = new URL(rawUrl);
let authHeader;
if (u.username || u.password) {
  authHeader = 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64');
  u.username = '';
  u.password = '';
}
const endpoint = u.toString();

async function rpc(method, params = []) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(authHeader ? { authorization: authHeader } : {}) },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'scan-test', method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC ${method} error: ${JSON.stringify(json.error)}`);
  return json.result;
}

// --- 스캐너와 동일한 헬퍼 ---
const outAddrs = (spk) => (spk?.address ? [spk.address] : (spk?.addresses ?? []));
// BTC 소수(JSON number) → satoshi 정수 문자열 (8자리 고정 후 소수점 제거 — float 오차 회피)
const toSat = (btc) => BigInt(Number(btc).toFixed(8).replace('.', '')).toString();

async function resolveVins(tx, prevoutInline) {
  const out = [];
  for (const vin of tx.vin ?? []) {
    if (vin.coinbase) continue;
    const outpoint = { txId: vin.txid, txIndex: vin.vout };
    if (prevoutInline) {
      const p = vin.prevout;
      if (!p) continue;
      out.push({ address: outAddrs(p.scriptPubKey)[0], value: Number(p.value), ...outpoint });
    } else {
      const prev = await rpc('getrawtransaction', [vin.txid, true]); // 미지원 노드 fallback (블록당 호출 많음)
      const pv = prev?.vout?.[vin.vout];
      if (!pv) continue;
      out.push({ address: outAddrs(pv.scriptPubKey)[0], value: Number(pv.value), ...outpoint });
    }
  }
  return out;
}

/** 스캐너 scanRange 미러: 수신(vout∈watch) + 출금/fee(vin∈watch) 행 생성 */
async function scanBlock(block, watch, prevoutInline) {
  const rows = [];
  for (const tx of block.tx ?? []) {
    const vins = await resolveVins(tx, prevoutInline);
    const isFrom = vins.some((v) => v.address && watch.has(v.address));

    for (const vout of tx.vout ?? []) {
      const hit = outAddrs(vout.scriptPubKey).find((a) => watch.has(a));
      if (hit && Number(vout.value) > 0) {
        rows.push({ kind: '수신', txId: tx.txid, txIndex: vout.n, address: hit, amountSat: toSat(vout.value),
          unspent: 'INSERT(usable=1)' });
      }
    }

    if (isFrom) {
      const inSum = vins.reduce((s, v) => s + BigInt(toSat(v.value || 0)), 0n);
      const outSum = (tx.vout ?? []).reduce((s, o) => s + BigInt(toSat(o.value || 0)), 0n);
      const sentOut = (tx.vout ?? [])
        .filter((o) => !outAddrs(o.scriptPubKey).some((a) => watch.has(a)))
        .reduce((s, o) => s + BigInt(toSat(o.value || 0)), 0n);
      const ourVins = vins.filter((v) => v.address && watch.has(v.address));
      rows.push({ kind: '출금', txId: tx.txid, txIndex: (tx.vout ?? []).length,
        from: ourVins[0]?.address, amountSat: sentOut.toString(),
        feeSat: inSum >= outSum ? (inSum - outSum).toString() : '(vin 미해소 — 생략)',
        spentOutpoints: ourVins.map((v) => `${v.txId}:${v.txIndex} → usable=0`) });
    }
  }
  return rows;
}

// --- main ---
const tip = await rpc('getblockcount');
const startHeight = Number(opt('height', tip));
const blocks = Number(opt('blocks', 1));
console.log(`tip=${tip}, 스캔: ${startHeight} ~ ${startHeight + blocks - 1}`);

// verbosity 3 지원 확인 (prevoutInline 플래그 결정과 동일)
let prevoutInline;
const forced = opt('verbosity');
if (forced) {
  prevoutInline = forced === '3';
} else {
  try {
    const hash = await rpc('getblockhash', [startHeight]);
    const probe = await rpc('getblock', [hash, 3]);
    prevoutInline = !!probe?.tx?.some((t) => t.vin?.some((v) => v.prevout));
    console.log(`verbosity 3: ${prevoutInline ? '지원(vin.prevout 인라인 — 추가 콜 0)' : '응답은 왔으나 prevout 없음 → 2 로 진행'}`);
  } catch (e) {
    prevoutInline = false;
    console.log(`verbosity 3 미지원(${e.message.slice(0, 80)}) → 2 + vin 마다 getrawtransaction fallback`);
  }
}

// 감시 주소: 지정 없으면 첫 블록에서 자동 표본(수신자 1 + 보낸이 1)
let watchList = opt('addr') ? opt('addr').split(',') : null;
const firstHash = await rpc('getblockhash', [startHeight]);
const firstBlock = await rpc('getblock', [firstHash, prevoutInline ? 3 : 2]);
if (!watchList) {
  let recv, sender;
  for (const tx of firstBlock.tx ?? []) {
    if (!recv) recv = tx.vout?.map((o) => outAddrs(o.scriptPubKey)[0]).find(Boolean);
    if (!sender && !tx.vin?.[0]?.coinbase) {
      const vins = await resolveVins(tx, prevoutInline);
      sender = vins.find((v) => v.address)?.address;
    }
    if (recv && sender) break;
  }
  watchList = [recv, sender].filter(Boolean);
  console.log(`자동 표본 감시주소: 수신자=${recv ?? '-'} / 보낸이=${sender ?? '-'}`);
}
const watch = new Set(watchList);

// 스캔 (스캐너와 동일 순회)
let total = 0;
for (let h = startHeight; h < startHeight + blocks; h++) {
  const block = h === startHeight ? firstBlock : await rpc('getblock', [await rpc('getblockhash', [h]), prevoutInline ? 3 : 2]);
  const rows = await scanBlock(block, watch, prevoutInline);
  console.log(`\n[block ${h}] tx ${block.tx?.length ?? 0}건 → 감지 ${rows.length}행`);
  for (const r of rows) console.log(' ', JSON.stringify(r));
  total += rows.length;
}
console.log(`\n완료: 총 ${total}행 (수신 행=detected_transactions+unspents INSERT, 출금 행=native fee 행+spentOutpoints usable=0)`);
