"use client";

import { motion } from "framer-motion";
import { Shield, Check, Terminal, Activity } from "lucide-react";
import { useState, useEffect } from "react";

export function SecurityInterface() {
    const [step, setStep] = useState(0);

    useEffect(() => {
        const timer = setInterval(() => {
            setStep((prev) => (prev + 1) % 4);
        }, 2000);
        return () => clearInterval(timer);
    }, []);

    return (
        <div className="relative w-[500px] h-[340px] perspective-[1000px] group">
            <motion.div
                initial={{ rotateY: 10, rotateX: 5 }}
                animate={{ rotateY: -10, rotateX: -5 }}
                transition={{
                    duration: 6,
                    repeat: Infinity,
                    repeatType: "mirror",
                    ease: "easeInOut"
                }}
                className="relative w-full h-full bg-black/60 border border-white/10 rounded-xl backdrop-blur-md overflow-hidden shadow-2xl flex flex-col"
            >
                {/* Top Bar */}
                <div className="h-10 border-b border-white/10 flex items-center px-4 gap-3 bg-white/5">
                    <div className="flex gap-1.5">
                        <div className="w-2.5 h-2.5 rounded-full bg-red-500/50" />
                        <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/50" />
                        <div className="w-2.5 h-2.5 rounded-full bg-green-500/50" />
                    </div>
                    <div className="ml-auto flex items-center gap-2 text-[10px] font-mono text-zinc-400">
                        <Terminal className="w-3 h-3" />
                        <span>audit_terminal_v2.sh</span>
                    </div>
                </div>

                {/* Code Area */}
                <div className="flex-1 p-6 font-mono text-xs relative">
                    {/* Scan Line */}
                    <motion.div
                        animate={{ top: ["0%", "100%"] }}
                        transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
                        className="absolute left-0 right-0 h-[1px] bg-expensee-neon shadow-[0_0_15px_var(--color-expensee-neon)] z-10 opacity-50"
                    />

                    <div className="space-y-1.5 text-zinc-500">
                        <div className="flex gap-2"><span className="text-zinc-700">01</span> <span className="text-purple-400">import</span> "@openzeppelin/contracts/security/ReentrancyGuard.sol";</div>
                        <div className="flex gap-2"><span className="text-zinc-700">02</span> </div>
                        <div className="flex gap-2"><span className="text-zinc-700">03</span> <span className="text-purple-400">contract</span> <span className="text-yellow-100">Vault</span> <span className="text-purple-400">is</span> ReentrancyGuard {"{"}</div>
                        <div className="flex gap-2"><span className="text-zinc-700">04</span>    <span className="text-purple-400">mapping</span>(address ={">"} uint256) <span className="text-purple-400">private</span> _balances;</div>
                        <div className="flex gap-2"><span className="text-zinc-700">05</span> </div>
                        <div className="flex gap-2 pl-4"><span className="text-zinc-600">// Auditing deposit function...</span></div>
                        <div className="flex gap-2"><span className="text-zinc-700">06</span>    <span className="text-purple-400">function</span> <span className="text-blue-300">deposit</span>() <span className="text-purple-400">external payable</span> {"{"}</div>
                        <div className="flex gap-2"><span className="text-zinc-700">07</span>       _balances[msg.sender] += msg.value;</div>
                        <div className="flex gap-2"><span className="text-zinc-700">08</span>    {"}"}</div>
                    </div>

                    {/* Floating Status Badge */}
                    <motion.div
                        className="absolute bottom-6 right-6 flex items-center gap-3 bg-zinc-900/90 border border-green-500/30 p-3 rounded-lg shadow-xl backdrop-blur-sm"
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                    >
                        <div className="relative">
                            <Shield className="w-5 h-5 text-green-400" />
                            <div className="absolute inset-0 bg-green-400/20 blur-lg animate-pulse" />
                        </div>
                        <div className="flex flex-col">
                            <span className="text-[10px] text-zinc-400 uppercase tracking-wider">Status</span>
                            <span className="text-xs font-bold text-green-400">SECURE SOURCE</span>
                        </div>
                    </motion.div>
                </div>

            </motion.div>

            {/* Background Decor */}
            <div className="absolute -inset-4 bg-expensee-neon/5 blur-2xl -z-10 rounded-full" />
        </div>
    );
}
