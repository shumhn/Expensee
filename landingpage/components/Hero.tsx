"use client";

import { motion } from "framer-motion";
import { Check, ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";

/* ─── Streaming Balance Counter ─── */
function StreamingBalance() {
    const [balance, setBalance] = useState(16034.2);
    useEffect(() => {
        const timer = setInterval(() => setBalance((v) => v + 0.17), 50);
        return () => clearInterval(timer);
    }, []);
    return (
        <span className="font-mono tabular-nums tracking-tight">
            {balance.toLocaleString("en-US", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
            })}
        </span>
    );
}

/* ─── Live Stream Asset Row ─── */
function LiveStreamRow({
    label,
    amount,
    change,
    changeColor,
}: {
    label: string;
    amount: string;
    change: string;
    changeColor: string;
}) {
    return (
        <div className="flex items-center justify-between py-2.5 border-b border-white/[0.06] last:border-0">
            <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-xs">
                    {label === "PayUSD" ? "💵" : label === "SOL" ? "◎" : "🔐"}
                </div>
                <div>
                    <div className="text-white text-xs font-bold">{label}</div>
                    <div className="text-[9px] text-zinc-500">
                        {amount}{" "}
                        <span className={changeColor}>{change}</span>
                    </div>
                </div>
            </div>
            <div className="text-right">
                <div className="text-white text-xs font-bold">
                    {label === "PayUSD"
                        ? "$1,090.96"
                        : label === "SOL"
                            ? "$3,967.57"
                            : "$886.54"}
                </div>
                <div className="text-[9px] text-zinc-500">
                    {label === "PayUSD"
                        ? "1,090.96 USDC"
                        : label === "SOL"
                            ? "15.86 SOL"
                            : "Encrypted"}
                </div>
            </div>
        </div>
    );
}

/* ─── Realistic Phone Frame ─── */
function PhoneMockup({ children }: { children: React.ReactNode }) {
    return (
        <div className="relative mx-auto" style={{ width: 320, maxWidth: "100%" }}>
            {/* Outer phone body */}
            <div
                className="relative rounded-[3rem] p-[10px] shadow-[0_50px_100px_-20px_rgba(0,0,0,0.8),0_0_60px_rgba(34,211,238,0.15)]"
                style={{
                    background: "linear-gradient(145deg, #2a2a2e 0%, #1a1a1c 50%, #0f0f10 100%)",
                    border: "1px solid rgba(255,255,255,0.08)",
                }}
            >
                {/* Phone edge highlight */}
                <div
                    className="absolute inset-0 rounded-[3rem] pointer-events-none"
                    style={{
                        background: "linear-gradient(145deg, rgba(255,255,255,0.06) 0%, transparent 40%)",
                    }}
                />

                {/* Side buttons - volume up */}
                <div
                    className="absolute -left-[3px] top-[100px] w-[3px] h-[28px] rounded-l-sm"
                    style={{ background: "linear-gradient(180deg, #3a3a3e, #1a1a1c)" }}
                />
                {/* Side buttons - volume down */}
                <div
                    className="absolute -left-[3px] top-[140px] w-[3px] h-[28px] rounded-l-sm"
                    style={{ background: "linear-gradient(180deg, #3a3a3e, #1a1a1c)" }}
                />
                {/* Side button - power */}
                <div
                    className="absolute -right-[3px] top-[120px] w-[3px] h-[40px] rounded-r-sm"
                    style={{ background: "linear-gradient(180deg, #3a3a3e, #1a1a1c)" }}
                />

                {/* Inner screen bezel */}
                <div
                    className="relative rounded-[2.4rem] overflow-hidden"
                    style={{
                        background: "#000",
                        border: "1px solid rgba(255,255,255,0.04)",
                    }}
                >
                    {/* Dynamic Island / Notch */}
                    <div className="absolute top-0 left-0 right-0 z-20 flex justify-center pt-2.5">
                        <div
                            className="flex items-center gap-2 px-5 py-1 rounded-full"
                            style={{
                                background: "#000",
                                border: "1px solid rgba(255,255,255,0.04)",
                                minWidth: 120,
                                height: 28,
                            }}
                        >
                            <div className="w-2.5 h-2.5 rounded-full bg-zinc-800 ring-1 ring-zinc-700" />
                            <div className="w-1.5 h-1.5 rounded-full bg-zinc-700" />
                        </div>
                    </div>

                    {/* Screen Content */}
                    <div className="relative">
                        {children}
                    </div>

                    {/* Home indicator bar */}
                    <div className="flex justify-center pb-2 pt-1 bg-[#0D0D0F]">
                        <div className="w-28 h-1 rounded-full bg-white/20" />
                    </div>
                </div>
            </div>
        </div>
    );
}

export function Hero() {
    const [activeTab, setActiveTab] = useState("Streams");

    return (
        <section className="relative min-h-screen flex items-start pt-24 md:pt-32 px-6 lg:px-12 overflow-hidden bg-black selection:bg-expensee-neon/30">
            {/* Background Glow */}
            <div className="absolute top-1/2 right-0 -translate-y-1/2 w-[800px] h-[800px] bg-expensee-neon/10 rounded-full blur-[120px] pointer-events-none" />

            <div className="max-w-7xl mx-auto grid lg:grid-cols-2 gap-8 items-center w-full">
                {/* ─── LEFT CONTENT ─── */}
                <div className="flex flex-col gap-4 z-10">
                    <motion.div
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ duration: 0.8 }}
                        className="flex items-center gap-3"
                    >
                        <div className="w-2 h-2 rounded-full bg-expensee-neon animate-pulse shadow-[0_0_10px_var(--color-expensee-neon)]" />
                        <span className="text-expensee-neon text-[10px] font-bold uppercase tracking-[0.4em]">
                            Currently on Devnet
                        </span>
                    </motion.div>

                    <motion.h1
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
                        className="text-[2.5rem] sm:text-[3.2rem] md:text-[3.8rem] lg:text-[4.2rem] font-black tracking-[-0.03em] leading-[1.06] text-white"
                    >
                        <span className="block">Private Payroll,</span>
                        <span className="block">Streaming</span>
                        <span className="text-zinc-500 block">in Real-Time</span>
                    </motion.h1>

                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 0.4, duration: 0.8 }}
                        className="flex flex-col gap-3"
                    >
                        {[
                            "Salaries encrypted end-to-end with Inco FHE. Invisible on-chain.",
                            "Earnings stream every second through MagicBlock secure vaults.",
                            "One-click Magic Scan finds your record — no setup, no friction.",
                            "Built-in AI agent handles payroll actions through natural language.",
                            "Pooled payouts keep your wallet anonymous. Withdraw in stealth.",
                        ].map((item, i) => (
                            <div key={i} className="flex items-center gap-3">
                                <Check
                                    className="w-5 h-5 text-expensee-neon"
                                    strokeWidth={3}
                                />
                                <span className="text-base md:text-lg text-gray-300 font-medium">
                                    {item}
                                </span>
                            </div>
                        ))}
                    </motion.div>

                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.6, duration: 0.8 }}
                        className="flex flex-wrap items-center gap-4 mt-2"
                    >
                        <a
                            href="https://onyx-fii.vercel.app/"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="w-full sm:w-auto px-8 py-4 bg-expensee-neon text-black text-lg font-bold rounded-full hover:scale-105 hover:brightness-110 transition-all text-center flex items-center justify-center gap-2"
                        >
                            Start Payroll
                        </a>
                        <a
                            href="#"
                            className="w-full sm:w-auto px-8 py-4 bg-transparent border border-white/20 text-white text-lg font-medium rounded-full hover:bg-white/5 transition-colors flex items-center justify-center gap-2"
                        >
                            Read Docs <ArrowRight className="w-5 h-5" />
                        </a>
                    </motion.div>

                    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-5 mt-4">
                        <div className="flex -space-x-3">
                            {[1, 2, 3].map((i) => (
                                <div
                                    key={i}
                                    className="w-9 h-9 rounded-full border border-black overflow-hidden bg-zinc-800 ring-2 ring-black"
                                >
                                    <img
                                        src={`/avatar-${i}.png`}
                                        alt={`Developer ${i}`}
                                        className="w-full h-full object-cover"
                                    />
                                </div>
                            ))}
                        </div>
                        <p className="text-[10px] sm:text-xs font-bold text-white uppercase tracking-[0.15em] sm:tracking-[0.25em] leading-tight max-w-[200px] sm:max-w-none">
                            Trusted by web3 teams
                        </p>
                    </div>
                </div>

                {/* ─── RIGHT — Phone Mockup with Dashboard ─── */}
                <motion.div
                    initial={{ opacity: 0, y: 60, rotateX: 8 }}
                    animate={{ opacity: 1, y: 0, rotateX: 0 }}
                    transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1], delay: 0.3 }}
                    className="relative flex items-center justify-center"
                    style={{ perspective: "1200px" }}
                >
                    {/* Gradient glow behind the phone */}
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                        <div className="w-[380px] h-[600px] bg-gradient-to-br from-[#22D3EE]/30 to-[#1EBA98]/30 rounded-full blur-[80px]" />
                    </div>

                    {/* Floating shield decoration */}
                    <motion.div
                        initial={{ opacity: 0, scale: 0.5 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ delay: 1, duration: 0.6 }}
                        className="absolute -top-4 -right-2 md:top-0 md:right-4 z-30"
                    >
                        <motion.div
                            animate={{ y: [0, -8, 0] }}
                            transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
                        >
                            <svg
                                viewBox="0 0 40 48"
                                fill="none"
                                className="w-12 h-14 md:w-16 md:h-20 drop-shadow-[0_8px_24px_rgba(34,211,238,0.4)]"
                            >
                                <path
                                    d="M20 0L40 10V28C40 38 30 46 20 48C10 46 0 38 0 28V10L20 0Z"
                                    fill="white"
                                    fillOpacity="0.9"
                                />
                                <path
                                    d="M20 6L34 13V28C34 35 27 41 20 43C13 41 6 35 6 28V13L20 6Z"
                                    fill="rgba(34,211,238,0.15)"
                                />
                            </svg>
                        </motion.div>
                    </motion.div>

                    {/* Subtle floating animation for the phone */}
                    <motion.div
                        animate={{ y: [0, -8, 0] }}
                        transition={{ duration: 5, repeat: Infinity, ease: "easeInOut" }}
                        className="relative z-10"
                    >
                        <PhoneMockup>
                            {/* App Screen Content */}
                            <div className="bg-[#0D0D0F] px-5 pt-12 pb-3">
                                {/* Card Header */}
                                <div className="flex items-center gap-2 mb-4">
                                    <div className="w-7 h-7 rounded-full bg-gradient-to-br from-cyan-400 to-emerald-500 flex items-center justify-center text-[10px] font-bold text-black">
                                        E
                                    </div>
                                    <span className="text-white text-xs font-bold">
                                        Employee Vault
                                    </span>
                                    <span className="text-zinc-500 text-[10px] ml-1">
                                        📋
                                    </span>
                                </div>

                                {/* Balance */}
                                <div className="mb-2">
                                    <div className="text-[9px] text-zinc-500 uppercase tracking-widest font-bold mb-0.5">
                                        LIVE EARNINGS
                                    </div>
                                    <div className="text-3xl font-black text-white tracking-tight leading-none">
                                        <StreamingBalance />
                                    </div>
                                    <div className="mt-1 text-[10px] text-zinc-500">
                                        streaming via MagicBlock ·{" "}
                                        <span className="text-emerald-400">
                                            encrypted
                                        </span>
                                    </div>
                                </div>

                                {/* Action Icons */}
                                <div className="flex items-center justify-between my-4 py-3 border-y border-white/[0.06]">
                                    {[
                                        { icon: "🪄", label: "Scan" },
                                        { icon: "🔒", label: "Encrypt" },
                                        { icon: "▶", label: "Stream" },
                                        { icon: "💸", label: "Withdraw" },
                                        { icon: "📄", label: "Payslip" },
                                    ].map((action, i) => (
                                        <div
                                            key={i}
                                            className="flex flex-col items-center gap-1"
                                        >
                                            <div className="w-9 h-9 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-xs">
                                                {action.icon}
                                            </div>
                                            <span className="text-[8px] text-zinc-500 font-medium">
                                                {action.label}
                                            </span>
                                        </div>
                                    ))}
                                </div>

                                {/* Tabs */}
                                <div className="flex items-center gap-5 mb-3">
                                    {["Earnings", "Payouts", "History"].map(
                                        (tab) => (
                                            <button
                                                key={tab}
                                                onClick={() => setActiveTab(tab)}
                                                className={`text-xs font-bold transition-colors pb-1 cursor-default ${activeTab === tab
                                                    ? "text-white border-b-2 border-cyan-400"
                                                    : "text-zinc-500 hover:text-zinc-300"
                                                    }`}
                                            >
                                                {tab}
                                            </button>
                                        )
                                    )}
                                </div>

                                {/* Total Value */}
                                <div className="mb-2">
                                    <div className="text-[8px] text-zinc-500 uppercase tracking-widest font-bold">
                                        ACCRUED PAYUSD
                                    </div>
                                    <div className="text-lg font-bold text-white tracking-tight">
                                        $1,090.96
                                    </div>
                                </div>

                                {/* Asset Rows */}
                                <div>
                                    <LiveStreamRow
                                        label="PayUSD"
                                        amount="Streaming"
                                        change="live"
                                        changeColor="text-emerald-400"
                                    />
                                    <LiveStreamRow
                                        label="FHE Vault"
                                        amount="Encrypted"
                                        change="private"
                                        changeColor="text-cyan-400"
                                    />
                                    <LiveStreamRow
                                        label="AI Agent"
                                        amount="Active"
                                        change="ready"
                                        changeColor="text-blue-400"
                                    />
                                </div>

                                {/* Bottom Nav */}
                                <div className="flex items-center justify-around mt-4 pt-3 border-t border-white/[0.06]">
                                    {["📋", "↔", "⏰", "⚙"].map(
                                        (icon, i) => (
                                            <button
                                                key={i}
                                                className="text-sm text-zinc-500 hover:text-white transition-colors p-1.5 cursor-default"
                                            >
                                                {icon}
                                            </button>
                                        )
                                    )}
                                </div>
                            </div>
                        </PhoneMockup>
                    </motion.div>
                </motion.div>
            </div>
        </section>
    );
}
