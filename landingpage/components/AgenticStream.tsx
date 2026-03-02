"use client";

import { motion } from "framer-motion";
import { Bot, Fingerprint, Cpu, Activity, CircleDollarSign } from "lucide-react";
import { useEffect, useState } from "react";

export function AgenticStream() {
    return (
        <div className="relative w-full h-[600px] flex items-center justify-center overflow-visible">
            {/* Ambient Background Glows */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[400px] h-[400px] bg-expensee-neon/20 rounded-full blur-[100px] pointer-events-none" />
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[200px] h-[200px] bg-white/10 rounded-full blur-[50px] pointer-events-none" />

            {/* A fixed coordinate system wrapper (800x600) scaled to fit */}
            <div className="relative w-[800px] h-[600px] scale-[0.6] sm:scale-75 lg:scale-90 flex-shrink-0 origin-center">

                {/* SVG Connection Beams Layer (Z: 10) */}
                <svg className="absolute inset-0 w-full h-full pointer-events-none z-10 overflow-visible">
                    <defs>
                        <linearGradient id="beam-cyan" x1="0%" y1="0%" x2="100%" y2="100%">
                            <stop offset="0%" stopColor="rgba(6,182,212,0)" />
                            <stop offset="100%" stopColor="rgba(6,182,212,0.8)" />
                        </linearGradient>
                        <linearGradient id="beam-indigo" x1="0%" y1="100%" x2="100%" y2="0%">
                            <stop offset="0%" stopColor="rgba(79,70,229,0)" />
                            <stop offset="100%" stopColor="rgba(79,70,229,0.8)" />
                        </linearGradient>
                        <linearGradient id="beam-cyan-out" x1="0%" y1="50%" x2="100%" y2="50%">
                            <stop offset="0%" stopColor="var(--color-expensee-neon)" />
                            <stop offset="100%" stopColor="rgba(6,182,212,0)" />
                        </linearGradient>
                        <linearGradient id="beam-indigo-out" x1="0%" y1="50%" x2="100%" y2="50%">
                            <stop offset="0%" stopColor="var(--color-expensee-primary)" />
                            <stop offset="100%" stopColor="rgba(79,70,229,0)" />
                        </linearGradient>

                        <filter id="glow">
                            <feGaussianBlur stdDeviation="3" result="coloredBlur" />
                            <feMerge>
                                <feMergeNode in="coloredBlur" />
                                <feMergeNode in="SourceGraphic" />
                            </feMerge>
                        </filter>
                    </defs>

                    {/* Agent -> Core (Path) */}
                    <DataBeam path="M 280 170 Q 320 170 400 300" gradient="url(#beam-blue)" delay={0} />

                    {/* FHE -> Core (Path) */}
                    <DataBeam path="M 280 430 Q 320 430 400 300" gradient="url(#beam-green)" delay={0.5} />

                    {/* Core -> Wallet (Straight Line Outgoing Stream) */}
                    <path d="M 400 300 Q 480 170 520 170" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
                    <motion.path
                        d="M 400 300 Q 480 170 520 170"
                        fill="none"
                        stroke="url(#beam-indigo-out)"
                        strokeWidth="3"
                        filter="url(#glow)"
                        initial={{ pathLength: 0, opacity: 0 }}
                        animate={{ pathLength: 1, opacity: [0, 1, 0] }}
                        transition={{ duration: 1.5, repeat: Infinity, ease: "linear", delay: 0.2 }}
                    />

                    {/* Core -> Income (Straight Line Outgoing Stream) */}
                    <path d="M 400 300 Q 480 430 520 430" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
                    <motion.path
                        d="M 400 300 Q 480 430 520 430"
                        fill="none"
                        stroke="url(#beam-cyan-out)"
                        strokeWidth="3"
                        filter="url(#glow)"
                        initial={{ pathLength: 0, opacity: 0 }}
                        animate={{ pathLength: 1, opacity: [0, 1, 0] }}
                        transition={{ duration: 1.5, repeat: Infinity, ease: "linear", delay: 0.7 }}
                    />
                </svg>

                {/* Central Holographic Sphere (Z: 20) */}
                <div className="absolute top-[300px] left-[400px] -translate-x-1/2 -translate-y-1/2 z-20">
                    <motion.div
                        animate={{ rotate: 360 }}
                        transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
                        className="relative w-48 h-48 rounded-full border-[1px] border-expensee-neon/30 flex items-center justify-center"
                    >
                        <motion.div
                            animate={{ rotate: -720 }}
                            transition={{ duration: 30, repeat: Infinity, ease: "linear" }}
                            className="absolute w-56 h-56 rounded-full border-[1px] border-dashed border-expensee-neon/50"
                        />
                        <div className="absolute inset-2 rounded-full border-[4px] border-expensee-neon/20 border-t-expensee-neon border-l-expensee-neon shadow-[0_0_40px_var(--color-expensee-neon)]" />

                        <div className="absolute inset-8 rounded-full bg-black border border-expensee-neon/40 flex items-center justify-center overflow-hidden">
                            <div className="absolute inset-0 bg-expensee-neon/10 animate-pulse" />
                            <div className="absolute top-0 w-full h-full bg-gradient-to-b from-transparent via-expensee-neon/20 to-transparent animate-[scan_2s_linear_infinite]" />
                            <Cpu className="w-12 h-12 text-expensee-neon z-10" />
                        </div>
                    </motion.div>

                </div>

                {/* AI Agent Panel (Top Left) */}
                <FloatingPanel
                    left={30} top={130}
                    delay={0}
                    icon={Bot}
                    title="AI Trigger"
                    status="Intercepting Intent"
                    color="text-expensee-primary"
                    glow="shadow-[0_0_20px_rgba(79,70,229,0.2)]"
                    border="border-expensee-primary/30"
                />

                {/* FHE Privacy Panel (Bottom Left) */}
                <FloatingPanel
                    left={30} top={390}
                    delay={0.2}
                    icon={Fingerprint}
                    title="Inco FHE"
                    status="Encrypting State"
                    color="text-expensee-neon"
                    glow="shadow-[0_0_20px_rgba(6,182,212,0.2)]"
                    border="border-expensee-neon/30"
                />

                {/* Right Side Top: Connection Status */}
                <FloatingPanel
                    left={520} top={130}
                    delay={0.4}
                    icon={Activity}
                    title="Live Stream"
                    status="Agent Connected"
                    color="text-expensee-primary"
                    glow="shadow-[0_0_20px_rgba(79,70,229,0.2)]"
                    border="border-expensee-primary/30"
                />

                {/* Right Side Bottom: Incoming Salary */}
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.8, delay: 0.6 }}
                    className="absolute z-30"
                    style={{ left: "520px", top: "390px" }}
                >
                    <motion.div
                        animate={{ y: [-5, 5, -5] }}
                        transition={{ duration: 4.5, repeat: Infinity, ease: "easeInOut" }}
                        className="w-56 h-[72px] p-4 rounded-xl bg-black/80 backdrop-blur-md border-dashed border border-expensee-neon/30 shadow-[0_0_20px_rgba(6,182,212,0.2)] flex items-center gap-4"
                    >
                        <div className="flex-shrink-0 p-2.5 rounded-lg bg-black/50 border border-dashed border-expensee-neon/30 text-expensee-neon">
                            <CircleDollarSign className="w-5 h-5" />
                        </div>
                        <div className="flex flex-col justify-center overflow-hidden">
                            <div className="text-white text-[10px] font-bold uppercase tracking-[0.2em] whitespace-nowrap">Incoming Salary</div>
                            <div className="text-expensee-neon -mt-1 scale-90 origin-left">
                                <StreamingBalance />
                            </div>
                        </div>
                    </motion.div>
                </motion.div>

            </div>

            <style jsx>{`
                @keyframes scan {
                    0% { transform: translateY(-100%); }
                    100% { transform: translateY(100%); }
                }
            `}</style>
        </div>
    );
}

function FloatingPanel({ left, top, delay, icon: Icon, title, status, color, glow, border }: any) {
    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay }}
            className={`absolute z-30`}
            style={{ left: `${left}px`, top: `${top}px` }}
        >
            <motion.div
                animate={{ y: [-5, 5, -5] }}
                transition={{ duration: 4 + Math.random() * 2, repeat: Infinity, ease: "easeInOut" }}
                className={`w-56 h-[72px] p-4 rounded-xl bg-black/80 backdrop-blur-md border-dashed border ${border} ${glow} flex items-center gap-4`}
            >
                <div className={`flex-shrink-0 p-2.5 rounded-lg bg-black/50 border border-dashed ${border} ${color}`}>
                    <Icon className="w-5 h-5" />
                </div>
                <div>
                    <div className="text-white text-xs font-bold uppercase tracking-wider mb-0.5 whitespace-nowrap">{title}</div>
                    <div className={`text-[9px] font-mono ${color} flex items-center gap-1 whitespace-nowrap`}>
                        <Activity className="w-3 h-3 animate-pulse" />
                        {status}
                    </div>
                </div>
            </motion.div>
        </motion.div>
    );
}

function DataBeam({ path, gradient, delay }: any) {
    return (
        <>
            <path d={path} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
            <motion.path
                d={path}
                fill="none"
                stroke={gradient}
                strokeWidth="3"
                filter="url(#glow)"
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ pathLength: 1, opacity: [0, 1, 0] }}
                transition={{ duration: 2, repeat: Infinity, ease: "easeInOut", delay }}
            />
        </>
    );
}

function StreamingBalance() {
    const [balance, setBalance] = useState(14850.50);

    useEffect(() => {
        const timer = setInterval(() => {
            setBalance(prev => prev + 0.17); // Fast ticking money
        }, 50);
        return () => clearInterval(timer);
    }, []);

    // Pad with zeros to keep width consistent
    return (
        <div className="font-mono text-lg text-white flex items-center gap-1 font-bold">
            <span>$</span>
            {balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
    );
}
