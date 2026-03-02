"use client";

import { motion, useScroll, useTransform } from "framer-motion";
import { useRef } from "react";
import { Terminal, Shield, Cpu, Activity, Zap, Globe, Lock, Target, Radio, Database, Server } from "lucide-react";

export function GlobalScale() {
    const containerRef = useRef<HTMLDivElement>(null);
    const { scrollYProgress } = useScroll({
        target: containerRef,
        offset: ["start end", "end start"]
    });

    const y = useTransform(scrollYProgress, [0, 1], [100, -100]);
    const opacity = useTransform(scrollYProgress, [0, 0.2, 0.8, 1], [0, 1, 1, 0]);

    return (
        <section ref={containerRef} className="pt-24 pb-24 px-6 bg-black relative overflow-hidden">
            {/* Background Atmosphere */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[1000px] h-[1000px] bg-expensee-neon/5 rounded-full blur-[160px] pointer-events-none" />

            <div className="max-w-7xl mx-auto relative z-10">
                <div className="flex flex-col lg:flex-row gap-16 items-start">
                    {/* Left: Intelligence Core Narrative */}
                    <div className="w-full lg:w-1/2 space-y-8">
                        <div className="space-y-6">
                            <motion.div
                                initial={{ opacity: 0, x: -20 }}
                                whileInView={{ opacity: 1, x: 0 }}
                                className="flex items-center gap-3"
                            >
                                <span className="w-12 h-[1px] bg-expensee-neon/40" />
                                <span className="text-expensee-neon text-[10px] font-bold uppercase tracking-[0.5em]">Global Payout Infrastructure</span>
                            </motion.div>

                            <motion.h2
                                initial={{ opacity: 0, y: 30 }}
                                whileInView={{ opacity: 1, y: 0 }}
                                viewport={{ once: true }}
                                className="text-4xl md:text-8xl font-black uppercase tracking-tight text-white leading-[1.1]"
                            >
                                Your Payroll<br />
                                <span className="inline-block pr-4 text-transparent bg-clip-text bg-gradient-to-r from-zinc-400 to-zinc-700">Automated.</span>
                            </motion.h2>

                            <motion.p
                                initial={{ opacity: 0 }}
                                whileInView={{ opacity: 1 }}
                                transition={{ delay: 0.2 }}
                                className="text-zinc-500 text-lg md:text-xl font-medium max-w-lg leading-relaxed"
                            >
                                Expensee integrates seamlessly with your existing stack. Fund once, pay globally, and instantly sync data back to accounting.
                            </motion.p>
                        </div>

                        <div className="space-y-6">
                            <FeatureRow
                                title="Fund via Fiat or Crypto"
                                description="Wire USD or deposit USDC directly into your corporate multisig."
                                delay={0.1}
                            />
                            <FeatureRow
                                title="1-Click Batch Payouts"
                                description="Execute hundreds of individual payments with a single signature."
                                delay={0.2}
                            />
                            <FeatureRow
                                title="Native Accounting Sync"
                                description="Categorize everything in QuickBooks and Xero instantly."
                                delay={0.3}
                            />
                        </div>


                        <div>
                            <motion.div
                                initial={{ opacity: 0 }}
                                whileInView={{ opacity: 1 }}
                                className="p-6 rounded-3xl bg-zinc-900/50 border border-white/5 backdrop-blur-sm relative overflow-hidden group"
                            >
                                <div className="absolute inset-0 bg-gradient-to-r from-expensee-neon/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                                <div className="flex items-center justify-between mb-4">
                                    <div className="flex items-center gap-2">
                                        <div className="w-1.5 h-1.5 rounded-full bg-expensee-neon animate-pulse" />
                                        <span className="text-[10px] text-zinc-400 font-bold uppercase tracking-widest">NETWORK STATUS</span>
                                    </div>
                                    <span className="text-[10px] text-expensee-neon font-bold uppercase tracking-widest">Live On Solana</span>
                                </div>
                                <div className="space-y-2">
                                    <div className="flex justify-between text-[9px] uppercase font-bold text-zinc-500">
                                        <span>Current Payout Volume</span>
                                        <span>$4.2M+</span>
                                    </div>
                                    <div className="w-full h-1 bg-white/5 rounded-full overflow-hidden">
                                        <motion.div
                                            initial={{ width: 0 }}
                                            whileInView={{ width: "74.2%" }}
                                            transition={{ duration: 1.5, ease: "easeOut" }}
                                            className="h-full bg-expensee-neon"
                                        />
                                    </div>
                                </div>
                            </motion.div>
                        </div>
                    </div>

                    {/* Right: Immersive Visual Visual Mesh */}
                    <div className="w-full lg:w-1/2 relative aspect-square lg:aspect-auto lg:h-[700px] flex items-center justify-center">
                        <motion.div
                            style={{ y, opacity }}
                            className="relative w-full h-full flex items-center justify-center"
                        >
                            {/* Layered Orbits */}
                            {[...Array(3)].map((_, i) => (
                                <motion.div
                                    key={i}
                                    animate={{
                                        rotate: i % 2 === 0 ? 360 : -360,
                                        scale: [1, 1.05, 1],
                                    }}
                                    transition={{
                                        rotate: { duration: 20 + i * 10, repeat: Infinity, ease: "linear" },
                                        scale: { duration: 8, repeat: Infinity, ease: "easeInOut" }
                                    }}
                                    className="absolute rounded-full border border-white/[0.05] pointer-events-none"
                                    style={{
                                        width: `${300 + i * 150}px`,
                                        height: `${300 + i * 150}px`,
                                        boxShadow: i === 0 ? '0 0 50px rgba(30, 186, 152, 0.05)' : 'none'
                                    }}
                                >
                                    {[...Array(8)].map((_, j) => (
                                        <div
                                            key={j}
                                            className="absolute w-1 h-1 bg-zinc-700/50 rounded-full"
                                            style={{
                                                top: '50%',
                                                left: '50%',
                                                transform: `translate(-50%, -50%) rotate(${(360 / 8) * j}deg) translateY(-${(300 + i * 150) / 2}px)`
                                            }}
                                        />
                                    ))}
                                </motion.div>
                            ))}

                            {/* Center Core Visual */}
                            <div className="relative z-10">
                                <motion.div
                                    animate={{ scale: [1, 1.1, 1] }}
                                    transition={{ duration: 4, repeat: Infinity }}
                                    className="w-32 h-32 rounded-full bg-expensee-neon/10 border border-expensee-neon/30 flex items-center justify-center backdrop-blur-md shadow-[0_0_50px_rgba(30,186,152,0.2)]"
                                >
                                    <Cpu className="w-10 h-10 text-expensee-neon" />
                                    {/* Rotating Ring */}
                                    <motion.div
                                        animate={{ rotate: 360 }}
                                        transition={{ duration: 4, repeat: Infinity, ease: "linear" }}
                                        className="absolute inset-[-10px] rounded-full border border-dashed border-expensee-neon/20"
                                    />
                                </motion.div>
                            </div>

                            {/* Floating HUD Cards */}
                            <div className="absolute inset-0 z-20 pointer-events-none">
                                {/* Top Left: Research Stream */}
                                <motion.div
                                    initial={{ opacity: 0, x: -50 }}
                                    whileInView={{ opacity: 1, x: 0 }}
                                    className="absolute top-[10%] left-0 bg-black/60 backdrop-blur-xl border border-white/10 p-4 md:p-5 rounded-2xl shadow-2xl w-56 md:w-64 scale-90 md:scale-100 origin-top-left"
                                >
                                    <div className="flex items-center justify-between mb-4 border-b border-white/5 pb-2">
                                        <span className="text-[10px] text-expensee-neon font-black uppercase tracking-widest">PAYOUT_LEDGER</span>
                                        <div className="flex gap-1">
                                            {[1, 2, 3].map(i => <div key={i} className="w-1 h-1 bg-expensee-neon animate-pulse" style={{ animationDelay: `${i * 0.2}s` }} />)}
                                        </div>
                                    </div>
                                    <div className="space-y-2 font-mono text-[9px]">
                                        <div className="flex justify-between text-zinc-500">
                                            <span>{'>'} ID: _8291_S</span>
                                            <span className="text-expensee-neon">[ACTIVE]</span>
                                        </div>
                                        <div className="h-10 overflow-hidden relative">
                                            <motion.div
                                                animate={{ y: [0, -40] }}
                                                transition={{ duration: 5, repeat: Infinity, ease: "linear" }}
                                                className="space-y-1 text-zinc-600"
                                            >
                                                <p>BATCHING_STABLECOINS...</p>
                                                <p>SETTLING_VIA_SOLANA</p>
                                                <p>COMPLIANCE_AUTH_OK</p>
                                                <p>RECEIPT_SENT_ENCRYPTED</p>
                                                <p>LEDGER_SYNC_COMPLETE</p>
                                            </motion.div>
                                        </div>
                                    </div>
                                </motion.div>

                                {/* Bottom Right: Security Protocol */}
                                <motion.div
                                    initial={{ opacity: 0, x: 50 }}
                                    whileInView={{ opacity: 1, x: 0 }}
                                    className="absolute bottom-[20%] right-0 bg-zinc-900/80 backdrop-blur-xl border border-white/10 p-4 md:p-5 rounded-2xl shadow-2xl w-48 md:w-56 scale-90 md:scale-100 origin-bottom-right"
                                >
                                    <div className="flex items-center gap-3 mb-3">
                                        <div className="p-2 bg-zinc-800 rounded-lg">
                                            <Lock className="w-4 h-4 text-expensee-neon" />
                                        </div>
                                        <div>
                                            <p className="text-[10px] text-zinc-400 font-bold uppercase tracking-wider">Protocol</p>
                                            <p className="text-xs text-white font-black uppercase">v2.4 SECURE</p>
                                        </div>
                                    </div>
                                    <div className="w-full h-[2px] bg-white/5 relative overflow-hidden">
                                        <motion.div
                                            animate={{ left: ["-100%", "100%"] }}
                                            transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                                            className="absolute top-0 bottom-0 w-1/2 bg-expensee-neon/40 blur-[2px]"
                                        />
                                    </div>
                                </motion.div>

                                {/* Center Right: Node Map */}
                                <motion.div
                                    initial={{ opacity: 0, scale: 0.8 }}
                                    whileInView={{ opacity: 1, scale: 1 }}
                                    className="absolute top-[40%] right-[5%] md:right-[10%] p-3 md:p-4 bg-black/40 border border-white/5 rounded-full backdrop-blur-sm scale-75 md:scale-100"
                                >
                                    <div className="relative w-12 h-12">
                                        <Globe className="w-12 h-12 text-zinc-700" />
                                        <motion.div
                                            animate={{ opacity: [0, 1, 0] }}
                                            transition={{ duration: 2, repeat: Infinity }}
                                            className="absolute top-2 right-2 w-2 h-2 bg-expensee-neon rounded-full shadow-[0_0_10px_var(--color-expensee-neon)]"
                                        />
                                    </div>
                                </motion.div>
                            </div>
                        </motion.div>
                    </div>
                </div>
            </div>

            {/* Scanning Line overlay */}
            <motion.div
                animate={{ top: ["-10%", "110%"] }}
                transition={{ duration: 10, repeat: Infinity, ease: "linear" }}
                className="absolute left-0 right-0 h-[300px] bg-gradient-to-b from-transparent via-expensee-neon/5 to-transparent pointer-events-none z-0"
            />
        </section >
    );
}

function FeatureRow({ title, description, delay }: { title: string, description: string, delay: number }) {
    return (
        <motion.div
            initial={{ opacity: 0, x: -20 }}
            whileInView={{ opacity: 1, x: 0 }}
            transition={{ delay, duration: 0.5 }}
            className="flex items-start gap-4 group"
        >
            <div className="mt-1 w-8 h-8 rounded-lg bg-zinc-900/50 border border-white/10 flex items-center justify-center flex-shrink-0 group-hover:border-expensee-neon/30 transition-colors">
                <Shield className="w-4 h-4 text-zinc-500 group-hover:text-expensee-neon transition-colors" />
            </div>
            <div>
                <h3 className="text-base font-bold text-white mb-1 group-hover:text-expensee-neon transition-colors">{title}</h3>
                <p className="text-sm text-zinc-500 leading-relaxed font-medium">{description}</p>
            </div>
        </motion.div>
    );
}
