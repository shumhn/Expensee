"use client";

import { motion } from "framer-motion";
import { Check, ArrowRight } from "lucide-react";
import { AgenticStream } from "@/components/AgenticStream";

export function Hero() {
    return (
        <section className="relative min-h-screen flex items-start pt-24 md:pt-32 px-6 lg:px-12 overflow-hidden bg-black selection:bg-expensee-neon/30">
            {/* Background Glow */}
            <div className="absolute top-1/2 right-0 -translate-y-1/2 w-[800px] h-[800px] bg-expensee-neon/10 rounded-full blur-[120px] pointer-events-none" />

            <div className="max-w-7xl grid lg:grid-cols-2 gap-12 items-start w-full">
                {/* Left Content */}
                <div className="flex flex-col gap-6 z-10">
                    <motion.div
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ duration: 0.8 }}
                        className="flex items-center gap-3"
                    >
                        <div className="w-2 h-2 rounded-full bg-expensee-neon animate-pulse shadow-[0_0_10px_var(--color-expensee-neon)]" />
                        <span className="text-expensee-neon text-[10px] font-bold uppercase tracking-[0.4em]">Currently on Devnet</span>
                    </motion.div>

                    <motion.h1
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
                        className="text-3xl sm:text-4xl md:text-7xl font-black tracking-[-0.02em] leading-[1.1] text-white"
                    >
                        <span className="block"> Private Payroll </span>
                        <span className="text-zinc-500 block" >in Real time</span>
                    </motion.h1>

                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 0.4, duration: 0.8 }}
                        className="flex flex-col gap-4"
                    >
                        {[
                            "Fully Homomorphic Encryption (FHE) via Inco.",
                            "Real-time payroll accrual via MagicBlock TEEs.",
                            "Stealth address privacy with Umbra.",
                            "Automated settlements with Expensee Keeper."
                        ].map((item, i) => (
                            <div key={i} className="flex items-center gap-3">
                                <Check className="w-5 h-5 text-expensee-neon" strokeWidth={3} />
                                <span className="text-base md:text-lg text-gray-300 font-medium">{item}</span>
                            </div>
                        ))}
                    </motion.div>

                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.6, duration: 0.8 }}
                        className="flex flex-wrap items-center gap-4 mt-4"
                    >
                        <a
                            href="https://onyx-fii.vercel.app/employer"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="w-full sm:w-auto px-8 py-4 bg-expensee-neon text-black text-lg font-bold rounded-full hover:scale-105 hover:brightness-110 transition-all text-center flex items-center justify-center gap-2"
                        >
                            Employer Dashboard
                        </a>
                        <a
                            href="https://onyx-fii.vercel.app/employee"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="w-full sm:w-auto px-8 py-4 bg-transparent border border-white/20 text-white text-lg font-medium rounded-full hover:bg-white/5 transition-colors flex items-center justify-center gap-2"
                        >
                            Employee Portal <ArrowRight className="w-5 h-5" />
                        </a>
                    </motion.div>

                    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-5 mt-8">
                        <div className="flex -space-x-3">
                            {[1, 2, 3].map(i => (
                                <div key={i} className="w-9 h-9 rounded-full border border-black overflow-hidden bg-zinc-800 ring-2 ring-black">
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

                {/* Right Visual - Agentic Payment Stream */}
                <div className="relative h-[600px] flex items-center justify-center">
                    <div className="relative z-10 w-full scale-90 sm:scale-100 lg:scale-110">
                        <AgenticStream />
                    </div>
                </div>
            </div>


            {/* Removed unused keyframes */}
        </section>
    );
}

// Removed unused CodeLine component
