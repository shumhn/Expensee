"use client";

import { motion } from "framer-motion";
import { Shield, Fingerprint, Activity } from "lucide-react";

export function HolographicCard() {
    return (
        <div className="relative w-[420px] h-[260px] perspective-[1000px] group">
            <motion.div
                initial={{ rotateY: 20, rotateX: 10, scale: 0.9 }}
                animate={{ rotateY: -20, rotateX: -10, scale: 1 }}
                transition={{
                    duration: 8,
                    repeat: Infinity,
                    repeatType: "mirror",
                    ease: "easeInOut"
                }}
                style={{ transformStyle: "preserve-3d" }}
                className="relative w-full h-full rounded-[24px] bg-gradient-to-br from-zinc-900 to-black border border-white/10 shadow-2xl backdrop-blur-xl overflow-hidden"
            >
                {/* Holographic Gradient Overlay */}
                <div className="absolute inset-0 bg-gradient-to-tr from-transparent via-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-700 pointer-events-none z-20" style={{ mixBlendMode: 'overlay' }} />

                {/* Top Shine */}
                <div className="absolute top-0 left-0 w-full h-1/2 bg-gradient-to-b from-white/10 to-transparent opacity-50 z-10" />

                <div className="relative z-30 p-6 h-full flex flex-col justify-between">
                    {/* Header: Node Identity */}
                    <div className="flex justify-between items-center border-b border-white/10 pb-4">
                        <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center">
                                <Shield className="w-4 h-4 text-expensee-neon" />
                            </div>
                            <div>
                                <div className="text-white text-xs font-bold tracking-widest uppercase">Smart Contract Auditor</div>
                                <div className="text-zinc-500 text-[10px] font-mono">EVM Compatible</div>
                            </div>
                        </div>
                        <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-green-500/10 border border-green-500/20 text-green-500 text-[10px] font-bold uppercase animate-pulse">
                            <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                            Online
                        </div>
                    </div>

                    {/* Middle: Live Activity Visualization */}
                    <div className="flex-1 flex items-end gap-1 py-4">
                        {[...Array(12)].map((_, i) => (
                            <div
                                key={i}
                                className="w-full bg-expensee-neon/20 rounded-t-sm relative overflow-hidden"
                                style={{
                                    height: `${30 + Math.random() * 50}%`,
                                    animation: `barHeight 2s ease-in-out infinite alternate ${i * 0.1}s`
                                }}
                            >
                                <div className="absolute bottom-0 inset-x-0 h-full bg-gradient-to-t from-expensee-neon/80 to-transparent opacity-50" />
                            </div>
                        ))}
                    </div>

                    {/* Footer: Stats */}
                    <div className="grid grid-cols-2 gap-4 pt-4 border-t border-white/10">
                        <div>
                            <div className="text-zinc-500 text-[10px] uppercase tracking-wider mb-1">Total Secured</div>
                            <div className="text-white text-sm font-mono font-bold">$420.5M</div>
                        </div>
                        <div>
                            <div className="text-zinc-500 text-[10px] uppercase tracking-wider mb-1">Vulnerabilities Detected</div>
                            <div className="text-white text-sm font-mono font-bold text-expensee-neon">127</div>
                        </div>
                    </div>
                </div>

                {/* CSS for Bar Animation included in style tag in global or here if possible, 
            but for now relying on inline style or existing animations. 
            Let's add a style block for the bar animation to ensure it works. 
        */}
                <style jsx>{`
            @keyframes barHeight {
                0% { transform: scaleY(0.5); }
                100% { transform: scaleY(1); }
            }
        `}</style>
            </motion.div>
        </div>
    );
}
