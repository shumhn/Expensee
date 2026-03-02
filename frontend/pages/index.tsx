import Head from 'next/head';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';

const WalletButton = dynamic(() => import('../components/WalletButton'), {
  ssr: false,
});

import { Logo } from '../components/Logo';

function StreamingBalance() {
  const [balance, setBalance] = useState(16034.2);
  useEffect(() => {
    const timer = setInterval(() => setBalance((v) => v + 0.17), 50);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="font-mono tabular-nums tracking-tight">
      {balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
    </span>
  );
}

function LiveStreamRow({ label, amount, change, changeColor }: { label: string; amount: string; change: string; changeColor: string }) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-white/[0.06] last:border-0">
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-sm">
          {label === 'PayUSD' ? '💵' : label === 'SOL' ? '◎' : '🔐'}
        </div>
        <div>
          <div className="text-white text-sm font-bold">{label}</div>
          <div className="text-[10px] text-zinc-500">{amount} <span className={changeColor}>{change}</span></div>
        </div>
      </div>
      <div className="text-right">
        <div className="text-white text-sm font-bold">{label === 'PayUSD' ? '$1,090.96' : label === 'SOL' ? '$3,967.57' : '$886.54'}</div>
        <div className="text-[10px] text-zinc-500">{label === 'PayUSD' ? '1,090.96 USDC' : label === 'SOL' ? '15.86 SOL' : 'Encrypted'}</div>
      </div>
    </div>
  );
}

export default function HomePage() {
  const [mounted, setMounted] = useState(false);
  const [activeTab, setActiveTab] = useState('Streams');
  useEffect(() => setMounted(true), []);

  return (
    <>
      <Head>
        <title>Expensee | Private Streaming Payroll</title>
        <meta name="description" content="Private streaming payroll on Solana. FHE-encrypted salaries, stealth routing, keeper automation." />
      </Head>

      <div className={`solflare-page-wrapper ${mounted ? 'opacity-100' : 'opacity-0'} transition-opacity duration-500`}>
        <div className="solflare-page">
          {/* ─── LEFT PANEL ─── */}
          <div className="solflare-left">
            {/* Logo */}
            <div className="flex items-center gap-3 mb-auto">
              <Logo className="w-10 h-10" />
              <span className="text-2xl font-black tracking-[-0.03em] text-white uppercase" style={{ fontFamily: 'var(--font-outfit), sans-serif' }}>
                Expensee
              </span>
            </div>

            {/* Hero Content */}
            <div className="flex flex-col items-start justify-center flex-1 max-w-lg">
              <h1 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-black tracking-[-0.04em] leading-[1.05] text-white mb-8" style={{ fontFamily: 'var(--font-outfit), sans-serif' }}>
                Get the best
                <br />
                <span className="text-white">Payroll</span>
                <br />
                <span className="text-white">experience</span>
              </h1>

              <div className="flex flex-col gap-3 w-full max-w-sm">
                <Link
                  href="/employer"
                  className="solflare-btn-primary"
                >
                  Open Employer
                </Link>
                <Link
                  href="/employee"
                  className="solflare-btn-secondary"
                >
                  Open Employee
                </Link>
              </div>
            </div>

            {/* Bottom Left Corner */}
            <div className="mt-auto pt-8">
              <div className="flex items-center gap-3">
                <div className="w-6 h-6 rounded bg-white/10 flex items-center justify-center">
                  <svg className="w-3.5 h-3.5 text-white/60" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                </div>
                <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-[0.15em]">Powered by Solana</span>
              </div>
            </div>
          </div>

          {/* ─── RIGHT PANEL ─── */}
          <div className="solflare-right overflow-hidden flex items-center justify-center p-8 bg-gradient-to-br from-[#22D3EE] to-[#1EBA98]">
            {/* Floating Dashboard Card */}
            <div className="solflare-card-wrapper">
              <div className="solflare-dashboard-card">
                {/* Card Header */}
                <div className="flex items-center gap-2 mb-4">
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-cyan-400 to-emerald-500 flex items-center justify-center text-xs font-bold text-black">E</div>
                  <span className="text-white text-sm font-bold">Main Vault</span>
                  <span className="text-zinc-500 text-[10px] ml-1">📋</span>
                </div>

                {/* Balance */}
                <div className="mb-1">
                  <div className="text-[10px] text-zinc-500 uppercase tracking-widest font-bold mb-1">BALANCE</div>
                  <div className="text-4xl font-black text-white tracking-tight leading-none">
                    <StreamingBalance />
                  </div>
                  <div className="mt-1 text-[11px] text-zinc-500">
                    +$840.19 · <span className="text-emerald-400">+5.24%</span>
                  </div>
                </div>

                {/* Action Icons */}
                <div className="flex items-center gap-4 my-5 py-4 border-y border-white/[0.06]">
                  {[
                    { icon: '↓', label: 'Receive' },
                    { icon: '🏦', label: 'Fund' },
                    { icon: '↔', label: 'Swap' },
                    { icon: '🔒', label: 'Encrypt' },
                    { icon: '▶', label: 'Stream' },
                  ].map((action, i) => (
                    <div key={i} className="flex flex-col items-center gap-1.5 flex-1">
                      <div className="w-10 h-10 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-sm hover:bg-white/10 transition-colors cursor-default">
                        {action.icon}
                      </div>
                      <span className="text-[9px] text-zinc-500 font-medium">{action.label}</span>
                    </div>
                  ))}
                </div>

                {/* Tabs */}
                <div className="flex items-center gap-6 mb-4">
                  {['Streams', 'Payroll', 'History'].map((tab) => (
                    <button
                      key={tab}
                      onClick={() => setActiveTab(tab)}
                      className={`text-sm font-bold transition-colors pb-1 ${activeTab === tab ? 'text-white border-b-2 border-cyan-400' : 'text-zinc-500 hover:text-zinc-300'}`}
                    >
                      {tab}
                    </button>
                  ))}
                </div>

                {/* Total Value */}
                <div className="mb-3">
                  <div className="text-[9px] text-zinc-500 uppercase tracking-widest font-bold">TOTAL VALUE</div>
                  <div className="text-xl font-bold text-white tracking-tight">$8,367.32</div>
                </div>

                {/* Asset Rows */}
                <div>
                  <LiveStreamRow label="SOL" amount="$250.32" change="+6.02%" changeColor="text-emerald-400" />
                  <LiveStreamRow label="PayUSD" amount="$1.00" change="+0.01%" changeColor="text-emerald-400" />
                  <LiveStreamRow label="FHE Vault" amount="Encrypted" change="" changeColor="" />
                </div>

                {/* Bottom Nav */}
                <div className="flex items-center justify-around mt-5 pt-4 border-t border-white/[0.06]">
                  {['📋', '↔', '⏰', '⚙'].map((icon, i) => (
                    <button key={i} className="text-lg text-zinc-500 hover:text-white transition-colors p-2">
                      {icon}
                    </button>
                  ))}
                </div>
              </div>

              {/* Floating shield decoration */}
              <div className="solflare-shield">
                <svg viewBox="0 0 40 48" fill="none" className="w-12 h-14">
                  <path d="M20 0L40 10V28C40 38 30 46 20 48C10 46 0 38 0 28V10L20 0Z" fill="white" fillOpacity="0.9" />
                  <path d="M20 6L34 13V28C34 35 27 41 20 43C13 41 6 35 6 28V13L20 6Z" fill="rgba(34,211,238,0.15)" />
                </svg>
              </div>
            </div>

          </div>
        </div>
      </div>
    </>
  );
}
