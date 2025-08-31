
"use client";

// ✅ CREATOR-SNIPE x100 (Solana) — ПРОДАКШН+ (risk checks + partial sell + USDC quick swap)
// Новое в этой версии:
//  - Проверка риска токена (в т.ч. интеграция с RugCheck при наличии, плюс локальная эвристика)
//  - Частичная продажа 25% / 50% / 75% (TOKEN → SOL/USDC)
//  - Быстрый своп в USDC (переключатель назначения для продажи)
//  - Те же Buy/Sell через Jupiter v6, авто-мониторинг Dexscreener
//
// Важно: код вызывает публичные API без ключей. Если RugCheck заблокирует CORS/лимиты,
//        модуль мягко деградирует до локальной оценки риска (без запрета покупки).
//        Это не финсовет. Делайте собственную проверку.

import React, { useEffect, useMemo, useState } from "react";
import {
  ConnectionProvider,
  WalletProvider,
  useWallet,
} from "@solana/wallet-adapter-react";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import {
  WalletModalProvider,
  WalletMultiButton,
} from "@solana/wallet-adapter-react-ui";
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
  BackpackWalletAdapter,
  CoinbaseWalletAdapter,
} from "@solana/wallet-adapter-wallets";
import {
  PublicKey,
  VersionedTransaction,
  clusterApiUrl,
  Connection,
} from "@solana/web3.js";
import { LineChart, Line, ResponsiveContainer } from "recharts";
import { Play, Pause, Rocket } from "lucide-react";

// ---------------------------------
// Constants / helpers
// ---------------------------------
const glass = "backdrop-blur-xl bg-white/5 border border-white/10 shadow-xl";
const pill = "px-3 py-1 rounded-full text-xs font-medium border border-white/10 bg-white/5";

const WSOL = "So11111111111111111111111111111111111111112"; // input mint for SOL
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC (mainnet)

type DexPair = {
  chainId?: string;
  pairAddress?: string;
  dexId?: string;
  baseToken?: { address?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
  priceUsd?: string;
  fdv?: number;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  pairCreatedAt?: number;
};

function short(a?: string, head = 4, tail = 4) {
  if (!a) return "";
  return a.length > 10 ? `${a.slice(0, head)}…${a.slice(-tail)}` : a;
}
function clamp(n: number, min: number, max: number) { return Math.min(max, Math.max(min, n)); }
function pct(n: number) { return `${n.toFixed(1)}%`; }
function lamports(sol: number) { return Math.floor(clamp(sol, 0, 10_000) * 1e9); }

function clampSortScore(rows: DexPair[]): DexPair[] {
  const scorePair = (r: DexPair): number => {
    const now = Date.now();
    const ageMin = r.pairCreatedAt ? (now - r.pairCreatedAt) / 60000 : 9999;
    const ageScore = clamp(1 - Math.min(ageMin, 240) / 240, 0, 1);
    const liq = r.liquidity?.usd ?? 0;
    const vol = r.volume?.h24 ?? 0;
    const fdv = r.fdv ?? 0;
    const liqScore = clamp(Math.log10(1 + liq) / 5, 0, 1);
    const volScore = clamp(Math.log10(1 + vol) / 6, 0, 1);
    const fdvScore = fdv <= 0 ? 0.6 : clamp(1 - Math.log10(Math.max(1, fdv)) / 7, 0, 1);
    const ch = r.priceChange?.h1 ?? 0;
    const mom = ch <= 0 ? 0 : ch > 80 ? 0.2 : 0.6 + 0.4 * (1 - ch / 80);
    const total = 0.25 * ageScore + 0.25 * liqScore + 0.25 * volScore + 0.15 * fdvScore + 0.1 * mom;
    return Number((total * 100).toFixed(1));
  };
  return rows.slice().sort((a, b) => scorePair(b) - scorePair(a));
}
function dexsLink(chainId?: string, pairAddress?: string) {
  if (!chainId || !pairAddress) return "https://dexscreener.com";
  return `https://dexscreener.com/${encodeURIComponent(chainId)}/${encodeURIComponent(pairAddress)}`;
}

// Jupiter
async function jupQuote({ inputMint, outputMint, amountLamports, slippageBps, onlyDirectRoutes = false }:{ inputMint:string; outputMint:string; amountLamports:number; slippageBps:number; onlyDirectRoutes?:boolean; }) {
  const url = new URL("https://quote-api.jup.ag/v6/quote");
  url.searchParams.set("inputMint", inputMint);
  url.searchParams.set("outputMint", outputMint);
  url.searchParams.set("amount", String(amountLamports));
  url.searchParams.set("slippageBps", String(slippageBps));
  if (onlyDirectRoutes) url.searchParams.set("onlyDirectRoutes", "true");
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Jupiter quote HTTP ${res.status}`);
  return await res.json();
}
async function jupSwapTx({ quoteResponse, userPublicKey }:{ quoteResponse:any; userPublicKey:string; }){
  const res = await fetch("https://quote-api.jup.ag/v6/swap",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ quoteResponse, userPublicKey, wrapAndUnwrapSol:true })
  });
  if (!res.ok) throw new Error(`Jupiter swap HTTP ${res.status}`);
  return await res.json();
}
async function sendJupSwap({ connection, walletSendTransaction, swapTransactionBase64 }:{ connection:Connection; walletSendTransaction:(tx:VersionedTransaction, conn:Connection, opts?:any)=>Promise<string>; swapTransactionBase64:string; }){
  const txBuf = Buffer.from(swapTransactionBase64, "base64");
  const tx = VersionedTransaction.deserialize(txBuf);
  const signature = await walletSendTransaction(tx, connection, { skipPreflight:true, maxRetries:2 });
  const latest = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  return signature;
}

// Token helpers
async function getTokenBalanceLamports(conn: Connection, owner: PublicKey, mint: PublicKey){
  const resp = await conn.getParsedTokenAccountsByOwner(owner, { mint });
  let ui = 0, base = 0n, dec = 0;
  for (const a of resp.value){
    const info:any = a.account.data;
    const uiAmt = Number(info.parsed.info.tokenAmount.uiAmount || 0);
    const amt = BigInt(info.parsed.info.tokenAmount.amount || 0);
    const decimals = Number(info.parsed.info.tokenAmount.decimals || 0);
    ui += uiAmt; base += amt; dec = decimals;
  }
  return { uiAmount: ui, baseAmount: base, decimals: dec };
}

// ---------------------------------
// RISK CHECKS (RugCheck + эвристика)
// ---------------------------------
export type RiskInfo = {
  source: "rugcheck" | "heuristic" | "unknown";
  ok: boolean; // итоговый флаг «можно покупать»
  score: number; // 0..100
  notes: string[]; // список предостережений
};

async function fetchRugcheck(mint: string): Promise<RiskInfo | null> {
  try{
    const resp = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}`);
    if (!resp.ok) throw new Error("rugcheck http");
    const data:any = await resp.json();
    // Нормализуем: чем ниже риск — тем выше score
    const flags:string[] = [];
    if (data?.topHolders && data.topHolders[0]?.percentage > 30) flags.push("Top1 > 30%");
    if (data?.isHoneypot) flags.push("Honeypot suspected");
    if (data?.mintAuthority === true) flags.push("Mint authority present");
    if (data?.freezeAuthority === true) flags.push("Freeze authority present");
    const ok = !flags.includes("Honeypot suspected");
    const score = Math.max(0, 100 - flags.length * 20);
    return { source:"rugcheck", ok, score, notes: flags };
  }catch{
    return null;
  }
}

function heuristicFromDex(pair: DexPair): RiskInfo {
  const notes: string[] = [];
  const liq = pair.liquidity?.usd ?? 0;
  const vol = pair.volume?.h24 ?? 0;
  const ageMin = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt)/60000 : 9999;
  if (liq < 3000) notes.push("Low liquidity < $3k");
  if (vol < 8000) notes.push("Low volume < $8k");
  if (ageMin < 15) notes.push("Very new < 15m");
  const h1 = pair.priceChange?.h1;
  if (typeof h1 === 'number' && h1 > 60) notes.push("Parabolic 1h > 60% — возможен дамп");
  const score = Math.max(0, 100 - notes.length * 15);
  return { source:"heuristic", ok: score >= 50, score, notes };
}

// ---------------------------------
// Root wrapper with Wallet Providers
// ---------------------------------
export default function Root(){
  const network = WalletAdapterNetwork.Mainnet;
  const endpoint = useMemo(()=> process.env.NEXT_PUBLIC_SOLANA_RPC || clusterApiUrl(network), [network]);
  const wallets = useMemo(()=> [ new PhantomWalletAdapter(), new SolflareWalletAdapter(), new BackpackWalletAdapter(), new CoinbaseWalletAdapter() ], []);
  return (
    <ConnectionProvider endpoint={String(endpoint)}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <App />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

// ---------------------------------
// Main App
// ---------------------------------
function App(): JSX.Element {
  const { publicKey, sendTransaction, connected } = useWallet();
  const [connection, setConnection] = useState<Connection | null>(null);
  useEffect(()=>{ const ep = (process.env.NEXT_PUBLIC_SOLANA_RPC as string) || clusterApiUrl("mainnet-beta"); setConnection(new Connection(ep, { commitment:"confirmed" })); },[]);

  // live sparkline (мок)
  const [run, setRun] = useState(true);
  const [live, setLive] = useState<{t:number;p:number}[]>([]);
  useEffect(()=>{ if(!run) return; let p=Math.random()*0.01+0.001; const id=setInterval(()=>{ p=Math.max(0.0001, p*(1+(Math.random()-0.5)*0.2)); setLive((old)=>[...old.slice(-120),{t:Date.now(),p}]); },900); return ()=>clearInterval(id); },[run]);

  // filters + autoscan
  const [recentOnlyMins, setRecentOnlyMins] = useState(60);
  const [minLiq, setMinLiq] = useState(4000);
  const [minVol, setMinVol] = useState(10000);
  const [maxFdv, setMaxFdv] = useState(600000);
  const [minH1, setMinH1] = useState(-5);
  const [maxH1, setMaxH1] = useState(40);
  const [autoRows, setAutoRows] = useState<DexPair[]>([]);
  const [lastScanAt, setLastScanAt] = useState<number | null>(null);
  const [autoScan, setAutoScan] = useState(true);
  const [scanSec, setScanSec] = useState(30);

  // risk cache: mint -> RiskInfo
  const [risk, setRisk] = useState<Record<string, RiskInfo>>({});
  async function ensureRiskForMint(mint?: string, pair?: DexPair){
    if(!mint) return;
    if(risk[mint]) return;
    // сначала RugCheck, при провале — эвристика
    const fromRug = await fetchRugcheck(mint);
    if (fromRug){ setRisk((m)=>({...m, [mint]: fromRug})); return; }
    if (pair){ setRisk((m)=>({...m, [mint]: heuristicFromDex(pair)})); return; }
    setRisk((m)=>({...m, [mint]: { source:"unknown", ok:true, score:60, notes:["No external risk data"] }}));
  }

  async function scanSolana(){
    try{
      const res = await fetch('https://api.dexscreener.com/latest/dex/pairs/solana');
      if(!res.ok) throw new Error(`Dexscreener HTTP ${res.status}`);
      const data = await res.json();
      let rows: DexPair[] = (data?.pairs||[]);
      const now = Date.now();
      const mins = Math.max(0, Number(recentOnlyMins)||0);
      rows = rows.filter(r => (mins<=0 || !r.pairCreatedAt || (now - r.pairCreatedAt) <= mins*60*1000));
      rows = rows.filter(r => (typeof r.liquidity?.usd!=="number" ? true : r.liquidity!.usd >= minLiq));
      rows = rows.filter(r => (typeof r.volume?.h24!=="number" ? true : r.volume!.h24 >= minVol));
      rows = rows.filter(r => (typeof r.fdv!=="number" ? true : r.fdv! <= maxFdv));
      rows = rows.filter(r => { const ch = r.priceChange?.h1; if (typeof ch!=="number") return true; return ch>=minH1 && ch<=maxH1; });
      rows = clampSortScore(rows).slice(0,100);
      setAutoRows(rows);
      setLastScanAt(Date.now());
      // подгружаем риск для первых N
      rows.slice(0,10).forEach((r)=> ensureRiskForMint(String(r.baseToken?.address), r));
    }catch(e){ /* ignore */ }
  }
  useEffect(()=>{ if(!autoScan) return; scanSolana(); const id=setInterval(scanSolana, Math.max(5, Number(scanSec)||30)*1000); return ()=>clearInterval(id); },[autoScan, scanSec, recentOnlyMins, minLiq, minVol, maxFdv, minH1, maxH1]);

  // trade settings
  const [stakeSol, setStakeSol] = useState(0.05); // SOL per shot
  const [slippageBps, setSlippageBps] = useState(50);
  const [sellDest, setSellDest] = useState<'SOL'|'USDC'>('SOL');

  // tx log
  const [txs, setTxs] = useState<{sig:string; t:number; note:string}[]>([]);
  function pushTx(sig: string, note: string){ setTxs((xs)=>[{sig, t:Date.now(), note}, ...xs].slice(0,20)); }

  // BUY: SOL -> TOKEN (mint)
  async function onBuyMint(outputMint: string, symbol?: string){
    if (!connection) return alert("Нет подключения к RPC");
    if (!connected || !publicKey) return alert("Подключите кошелёк");
    const r = risk[outputMint];
    if (r && (!r.ok || r.score < 50)){
      const sure = confirm(`Риск высокий (${r.source}, score ${r.score}). Всё равно купить?`);
      if (!sure) return;
    }
    try{
      const quote = await jupQuote({ inputMint: WSOL, outputMint, amountLamports: lamports(stakeSol), slippageBps });
      const { swapTransaction } = await jupSwapTx({ quoteResponse: quote, userPublicKey: publicKey!.toBase58() });
      const sig = await sendJupSwap({ connection, walletSendTransaction: sendTransaction, swapTransactionBase64: swapTransaction });
      pushTx(sig, `BUY ${symbol || short(outputMint)} for ${stakeSol} SOL`);
      alert(`Swap sent!\n${sig}`);
    }catch(e:any){ alert(`Buy failed: ${e?.message||e}`); }
  }

  // SELL helpers
  async function onSellPctMint(inputMint: string, pct: number, symbol?: string){
    if (!connection) return alert("Нет подключения к RPC");
    if (!connected || !publicKey) return alert("Подключите кошелёк");
    try{
      const { baseAmount, uiAmount, decimals } = await getTokenBalanceLamports(connection, publicKey, new PublicKey(inputMint));
      if (baseAmount === 0n) return alert("Нулевой баланс токена");
      const part = BigInt(Math.floor(Number(baseAmount) * clamp(pct, 0, 100) / 100));
      if (part === 0n) return alert("Слишком маленькая сумма для продажи");
      const outputMint = sellDest === 'USDC' ? USDC : WSOL;
      const quote = await jupQuote({ inputMint, outputMint, amountLamports: Number(part), slippageBps });
      const { swapTransaction } = await jupSwapTx({ quoteResponse: quote, userPublicKey: publicKey!.toBase58() });
      const sig = await sendJupSwap({ connection, walletSendTransaction: sendTransaction, swapTransactionBase64: swapTransaction });
      pushTx(sig, `SELL ${pct}% ${symbol || short(inputMint)} → ${sellDest}`);
      alert(`Swap sent!\n${sig}`);
    }catch(e:any){ alert(`Sell failed: ${e?.message||e}`); }
  }
  async function onSellMaxMint(inputMint: string, symbol?: string){ return onSellPctMint(inputMint, 100, symbol); }

  return (
    <div className="min-h-screen bg-[#0A0B0F] text-white">
      {/* HERO */}
      <section className="max-w-3xl mx-auto px-5 pt-12 pb-8 text-center">
        <div className="inline-flex items-center gap-2 mb-4">
          <Rocket className="w-5 h-5 text-cyan-300" />
          <span className={pill}>Solana Creator-Snipe</span>
        </div>
        <h1 className="text-3xl md:text-4xl font-bold leading-tight">Полноценный снайпер: риск-чек + частичная продажа + USDC</h1>
        <p className="mt-3 text白/70">Подключи кошелёк, выбери пару, покупай за SOL, продавай частями в SOL или USDC.</p>
        <div className="mt-4 flex items-center justify-center">
          <WalletMultiButton className="!bg白/10 !border !border白/10 !rounded-xl hover:!bg白/20" />
        </div>
        <div className="mt-5 inline-flex gap-3">
          <button onClick={()=>setRun(v=>!v)} className="px-4 py-2 rounded-xl bg白/10 border border白/10 hover:bg白/15">
            {run? (<span className="inline-flex items-center gap-2"><Play className="w-4 h-4 text-emerald-400"/> Live</span>) : (<span className="inline-flex items-center gap-2"><Pause className="w-4 h-4 text-yellow-300"/> Paused</span>)}
          </button>
        </div>
      </section>

      {/* LIVE SPARKLINE */}
      <section className="max-w-3xl mx-auto px-5">
        <div className={`${glass} rounded-2xl p-3 h-32`}>
          <div className="text-xs opacity-70 mb-1">Live mock price</div>
          <div className="h-24">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={live}><Line type="monotone" dataKey="p" dot={false} strokeWidth={2} /></LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>

      {/* SETTINGS */}
      <section className="max-w-3xl mx-auto px-5 mt-8 space-y-6">
        <div className={`${glass} rounded-2xl p-4`}>
          <h2 className="font-semibold mb-3">Торговые настройки</h2>
          <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 text-sm">
            <LabeledInput label="SOL per shot" type="number" value={String(stakeSol)} onChange={(v)=>setStakeSol(Number(v)||0)} />
            <LabeledInput label="Slippage bps" type="number" value={String(slippageBps)} onChange={(v)=>setSlippageBps(Math.max(1, Number(v)||50))} />
            <LabeledInput label="Автоскан, сек" type="number" value={String(scanSec)} onChange={(v)=>setScanSec(Math.max(5, Number(v)||30))} />
            <LabeledInput label="new ≤ мин" type="number" value={String(recentOnlyMins)} onChange={(v)=>setRecentOnlyMins(Number(v)||0)} />
            <div className="text-xs flex items-end">
              <button onClick={()=>setAutoScan(x=>!x)} className={`${pill} ${autoScan? 'border-emerald-400/50':''}`}>{autoScan? 'Auto-Scan: ON':'Auto-Scan: OFF'}</button>
            </div>
            <div className="text-xs flex items-end gap-2">
              <span className="opacity-70">Sell dest:</span>
              <button onClick={()=>setSellDest('SOL')} className={`${pill} ${sellDest==='SOL'?'border-emerald-400/50':''}`}>SOL</button>
              <button onClick={()=>setSellDest('USDC')} className={`${pill} ${sellDest==='USDC'?'border-emerald-400/50':''}`}>USDC</button>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs mt-3">
            <NumberFilter label="Min Liq $" value={minLiq} setValue={setMinLiq} />
            <NumberFilter label="Min Vol24h $" value={minVol} setValue={setMinVol} />
            <NumberFilter label "Max FDV $" value={maxFdv} setValue={setMaxFdv} />
            <NumberFilter label="Min 1h %" value={minH1} setValue={setMinH1} />
            <NumberFilter label="Max 1h %" value={maxH1} setValue={setMaxH1} />
          </div>
        </div>

        {/* FEED */}
        <div className={`${glass} rounded-2xl p-4`}>
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-semibold">Dexscreener — Solana</h2>
            <div className="text-xs opacity-70">послед. скан: {lastScanAt? new Date(lastScanAt).toLocaleTimeString(): '—'}</div>
          </div>
          <div className="mt-3 grid gap-2">
            {autoRows.map((r, i)=>{
              const mint = String(r.baseToken?.address||'');
              const info = risk[mint];
              return (
                <div key={(r.pairAddress||'auto')+i} className="bg-white/5 border border-white/10 rounded-xl px-3 py-2">
                  <div className="text-sm font-medium flex items-center justify-between">
                    <a href={dexsLink(r.chainId, r.pairAddress)} target="_blank" rel="noreferrer" className="hover:underline">
                      {(r.baseToken?.symbol||'???')}/{r.quoteToken?.symbol||'?'} · {r.dexId||'—'} · {r.chainId}
                    </a>
                    <div className="flex gap-2 text-xs">
                      <button onClick={()=>onBuyMint(mint, r.baseToken?.symbol)} className="px-3 py-1 rounded-lg bg-gradient-to-r from-cyan-400 to-emerald-400 text-black font-semibold" disabled={info? (!info.ok && info.score<50) : false}>Buy</button>
                      <div className="hidden sm:flex gap-1">
                        <button onClick={()=>onSellPctMint(mint,25,r.baseToken?.symbol)} className="px-2 py-1 rounded-lg bg-white/10 border border-white/10 hover:bg-white/15">25%</button>
                        <button onClick={()=>onSellPctMint(mint,50,r.baseToken?.symbol)} className="px-2 py-1 rounded-lg bg-white/10 border border-white/10 hover:bg-white/15">50%</button>
                        <button onClick={()=>onSellPctMint(mint,75,r.baseToken?.symbol)} className="px-2 py-1 rounded-lg bg-white/10 border border-white/10 hover:bg-white/15">75%</button>
                        <button onClick={()=>onSellPctMint(mint,100,r.baseToken?.symbol)} className="px-2 py-1 rounded-lg bg-white/10 border border-white/10 hover:bg-white/15">Max</button>
                      </div>
                    </div>
                  </div>
                  <div className="text-xs opacity-80 flex flex-wrap gap-3 mt-1">
                    {r.priceUsd && <span className={pill}>${Number(r.priceUsd).toFixed(6)}</span>}
                    {typeof r.fdv==='number' && <span className={pill}>FDV ${Math.round(r.fdv).toLocaleString()}</span>}
                    {typeof r.liquidity?.usd==='number' && <span className={pill}>Liq ${Math.round(r.liquidity.usd).toLocaleString()}</span>}
                    {typeof r.volume?.h24==='number' && <span className={pill}>Vol24h ${Math.round(r.volume.h24).toLocaleString()}</span>}
                    {typeof r.priceChange?.m5==='number' && <span className={pill}>5m {pct(r.priceChange.m5)}</span>}
                    {typeof r.priceChange?.h1==='number' && <span className={pill}>1h {pct(r.priceChange.h1)}</span>}
                    {r.pairCreatedAt && <span className={pill}>new {Math.max(0, Math.floor((Date.now() - r.pairCreatedAt)/60000))}m</span>}
                    <RiskBadge mint={mint} info={info} onLoad={()=>ensureRiskForMint(mint, r)} />
                  </div>
                </div>
              );
            })}
            {autoRows.length===0 && autoScan && <div className="text-xs opacity-70">Пока ничего не прошло по фильтрам.</div>}
          </div>
        </div>

        {/* TX LOG */}
        <div className={`${glass} rounded-2xl p-4`}>
          <h2 className="font-semibold mb-2">Транзакции</h2>
          <div className="grid gap-2 text-xs">
            {txs.map((x)=> (
              <a key={x.sig} href={`https://solscan.io/tx/${x.sig}`} target="_blank" rel="noreferrer" className="flex items-center justify-between bg-white/5 border border-white/10 rounded-xl px-3 py-2 hover:border-cyan-400/40">
                <span className="opacity-80">{new Date(x.t).toLocaleTimeString()} · {x.note}</span>
                <span className="font-mono">{short(x.sig,6,6)}</span>
              </a>
            ))}
            {txs.length===0 && <div className="text-white/60">Пока пусто</div>}
          </div>
          <div className="text-[11px] opacity-60 mt-2">Не является финсоветом. Риски — волатильность, ликвидность, MEV/слиппедж.</div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="max-w-3xl mx-auto px-5 py-10 text-xs opacity-60">Creator-Snipe x100 · Mainnet · Jupiter/WSOL/USDC • Session {short(Math.random().toString(36).slice(2,10))}</footer>
    </div>
  );
}

// ---------------------------------
// Tiny UI helpers
// ---------------------------------
function LabeledInput({ label, value, onChange, type = "text"}:{ label:string; value:string; onChange:(v:string)=>void; type?:string }){
  return (
    <label className="text-xs w-full">
      <div className="mb-1 opacity-70">{label}</div>
      <input type={type} value={value} onChange={(e)=>onChange(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 outline-none focus:border-cyan-400/50" />
    </label>
  );
}
function NumberFilter({ label, value, setValue }:{ label:string; value:number; setValue:(n:number)=>void }){
  return (
    <label className="text-[11px] w-full">
      <div className="mb-1 opacity-70">{label}</div>
      <input type="number" value={String(value)} onChange={(e)=>setValue(Number(e.target.value)||0)} className="w-full bg-white/5 border border-white/10 rounded-xl px-2 py-1 outline-none" />
    </label>
  );
}

// Risk badge component
function RiskBadge({ mint, info, onLoad }:{ mint:string; info?:RiskInfo; onLoad:()=>void }){
  useEffect(()=>{ if (!info) onLoad(); },[info, onLoad]);
  if (!info) return <span className={pill}>Risk: …</span>;
  const tone = info.ok && info.score>=70 ? 'border-emerald-400/50' : info.ok ? 'border-yellow-400/50' : 'border-red-400/50';
  const title = `${info.source} • score ${info.score}${info.notes.length? ' • ' + info.notes.join(', '): ''}`;
  return <span className={`${pill} ${tone}`} title={title}>Risk: {info.ok? (info.score>=70? 'OK':'Warn'):'Fail'}</span>;
}
