"use client";

import { motion } from "framer-motion";
import { Shield, Check, Lock, Zap, Activity } from "lucide-react";

export function HolographicShield() {
    return (
        <div className="relative w-[320px] h-[400px] perspective-[1000px] group flex items-center justify-center scale-[0.6] sm:scale-75 md:scale-90">
            <motion.div
                initial={{ rotateY: 10 }}
                animate={{ rotateY: -10 }}
                transition={{
                    duration: 6,
                    repeat: Infinity,
                    repeatType: "mirror",
                    ease: "easeInOut"
                }}
                style={{ transformStyle: "preserve-3d" }}
                className="relative w-[320px] h-[400px]"
            >
                {/* The Shield Container */}
                <div className="absolute inset-0 drop-shadow-[0_0_50px_rgba(35,209,232,0.3)]">
                    {/* SVG Border Layer */}
                    <svg viewBox="0 0 320 400" className="absolute inset-0 w-full h-full pointer-events-none z-50 overflow-visible">
                        <defs>
                            <filter id="glow-border" x="-20%" y="-20%" width="140%" height="140%">
                                <feGaussianBlur stdDeviation="2" result="blur" />
                                <feComposite in="SourceGraphic" in2="blur" operator="over" />
                            </filter>
                        </defs>
                        <path
                            d="M160 0 L320 60 V180 C320 280 260 360 160 400 C60 360 0 280 0 180 V60 L160 0 Z"
                            fill="none"
                            stroke="rgba(255,255,255,0.1)"
                            strokeWidth="1"
                        />
                        <path
                            d="M160 0 L320 60 V180 C320 280 260 360 160 400 C60 360 0 280 0 180 V60 L160 0 Z"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeDasharray="10 10"
                            className="animate-[dash_30s_linear_infinite] text-expensee-neon"
                            filter="url(#glow-border)"
                            style={{ strokeDashoffset: 0 }}
                        />
                    </svg>

                    {/* Main Glass Body */}
                    <div
                        className="w-full h-full bg-transparent backdrop-blur-md border-t border-l border-white/10 shadow-2xl relative z-10"
                        style={{
                            clipPath: "path('M160 0 L320 60 V180 C320 280 260 360 160 400 C60 360 0 280 0 180 V60 L160 0 Z')"
                        }}
                    >
                        {/* Background Grid */}
                        <div className="absolute inset-0 bg-[linear-gradient(rgba(35,209,232,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(35,209,232,0.03)_1px,transparent_1px)] bg-[size:24px_24px]" />

                        {/* Internal Glow */}
                        <div className="absolute top-0 inset-x-0 h-2/3 bg-gradient-to-b from-expensee-neon/10 to-transparent opacity-60" />

                        {/* Content Container - Adjusted Padding for Fit */}
                        <div className="absolute inset-0 flex flex-col items-center pt-12 pb-20 px-6 text-center">

                            {/* Icon - Moved Up */}
                            <div className="relative mb-4">
                                <div className="w-16 h-16 rounded-full bg-expensee-neon/10 flex items-center justify-center border border-expensee-neon/50 shadow-[0_0_30px_rgba(35,209,232,0.3)] animate-pulse">
                                    <Activity className="w-8 h-8 text-expensee-neon" />
                                </div>
                                <div className="absolute -inset-2 border border-dashed border-expensee-neon/30 rounded-full animate-[spin_10s_linear_infinite]" />
                            </div>

                            {/* Text */}
                            <h3 className="text-lg font-bold text-white tracking-widest uppercase mb-1 leading-tight">Expensee<br />Keeper</h3>
                            <p className="text-[10px] text-expensee-neon font-mono tracking-widest uppercase mb-6">Decentralized Network</p>

                            {/* Stats Row - Compact & Centered */}
                            <div className="w-full max-w-[220px] grid grid-cols-2 gap-2 border-t border-white/10 pt-4">
                                <div className="flex flex-col items-center p-2 rounded-lg bg-white/5">
                                    <span className="text-lg font-bold text-white">99.9%</span>
                                    <span className="text-[8px] text-zinc-400 uppercase tracking-wider">Uptime</span>
                                </div>
                                <div className="flex flex-col items-center p-2 rounded-lg bg-white/5">
                                    <span className="text-lg font-bold text-expensee-neon">1.2M+</span>
                                    <span className="text-[8px] text-zinc-400 uppercase tracking-wider">Tx Processed</span>
                                </div>
                            </div>
                        </div>

                        {/* Animated Scanner Line */}
                        <motion.div
                            animate={{ top: ["0%", "100%", "0%"] }}
                            transition={{ duration: 5, repeat: Infinity, ease: "linear" }}
                            className="absolute left-0 right-0 h-[1px] bg-expensee-neon/50 shadow-[0_0_15px_var(--color-expensee-neon)] z-30"
                        />
                    </div>
                </div>
            </motion.div>
        </div>
    );
}
