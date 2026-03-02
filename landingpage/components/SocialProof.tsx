"use client";

import { motion } from "framer-motion";
import { Check, Twitter } from "lucide-react";

const testimonials = [
    {
        name: "Sarah J.",
        handle: "@sarah_web3",
        text: "The FHE privacy on @Expensee is a game changer for our remote team. Finally, a way to stream salaries without exposing sensitive data on-chain. Ultimate peace of mind.",
        image: "https://api.dicebear.com/7.x/avataaars/svg?seed=Sarah",
        verified: true,
    },
    {
        name: "Marcus T.",
        handle: "@marcus_agencies",
        text: "Real-time salary streaming via MagicBlock TEEs has completely transformed how we handle payroll for our agency. Our contractors love seeing their balance grow every second.",
        image: "https://api.dicebear.com/7.x/avataaars/svg?seed=Marcus",
        verified: true,
    },
    {
        name: "Elena R.",
        handle: "@elena_dao",
        text: "Expensee's AI-assisted payroll planning is pure magic. I just type my intent, and it handles the complex distribution and private FHE streaming automatically. Zero friction.",
        image: "https://api.dicebear.com/7.x/avataaars/svg?seed=Elena",
        verified: true,
    },
    {
        name: "David K.",
        handle: "@david_startup",
        text: "From AI intent parsing to private FHE settlements, Expensee has solved the crypto payroll trilemma for our startup. It's the only truly unstoppable and private solution.",
        image: "https://api.dicebear.com/7.x/avataaars/svg?seed=David",
        verified: true,
    },
];

export function SocialProof() {
    return (
        <section className="pt-24 pb-24 px-6 bg-black overflow-hidden border-t border-white/5 relative">
            <div className="max-w-7xl mx-auto relative z-10">
                <div className="flex flex-col lg:flex-row gap-16 items-center">
                    {/* Testimonials Grid - Uniform Cards */}
                    <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-6">
                        {testimonials.map((testimonial, index) => (
                            <TestimonialCard key={index} data={testimonial} index={index} />
                        ))}
                    </div>

                    {/* Right Side - Large Brand Message */}
                    <div className="w-full lg:w-[400px] flex flex-col justify-center items-center lg:items-end text-center lg:text-right">
                        <motion.div
                            initial={{ opacity: 0, x: 50 }}
                            whileInView={{ opacity: 1, x: 0 }}
                            viewport={{ once: true }}
                            className="space-y-8"
                        >
                            <div className="space-y-3">
                                <motion.h2
                                    className="text-6xl md:text-7xl lg:text-8xl font-black uppercase tracking-tighter text-white leading-[1.1]"
                                    initial={{ opacity: 0, y: 20 }}
                                    whileInView={{ opacity: 1, y: 0 }}
                                    viewport={{ once: true }}
                                >
                                    10+
                                </motion.h2>
                                <motion.h2
                                    className="text-4xl md:text-5xl lg:text-6xl font-black uppercase tracking-tighter text-white leading-[1.1]"
                                    initial={{ opacity: 0, y: 20 }}
                                    whileInView={{ opacity: 1, y: 0 }}
                                    viewport={{ once: true }}
                                    transition={{ delay: 0.1 }}
                                >
                                    STARTUPS
                                </motion.h2>
                                <motion.p
                                    className="text-3xl md:text-4xl lg:text-5xl font-black uppercase tracking-tighter text-zinc-500"
                                    initial={{ opacity: 0, y: 20 }}
                                    whileInView={{ opacity: 1, y: 0 }}
                                    viewport={{ once: true }}
                                    transition={{ delay: 0.2 }}
                                >
                                    AND COUNTING
                                </motion.p>
                            </div>

                            <motion.div
                                className="flex flex-col items-center lg:items-end gap-6"
                                initial={{ opacity: 0 }}
                                whileInView={{ opacity: 1 }}
                                viewport={{ once: true }}
                                transition={{ delay: 0.3 }}
                            >
                                <div className="h-1 w-32 bg-expensee-neon/50 rounded-full" />
                                <p className="text-zinc-400 text-base md:text-xl font-bold uppercase tracking-[0.05em] max-w-[400px] leading-relaxed text-right">
                                    "Global payroll has shifted.<br />From TradFi to Crypto."
                                </p>
                            </motion.div>
                        </motion.div>
                    </div>
                </div>
            </div >

            {/* Background Atmosphere */}
            < div className="absolute top-1/2 right-0 w-[600px] h-[600px] bg-expensee-neon/5 rounded-full blur-[140px] pointer-events-none" />
        </section >
    );
}

function TestimonialCard({ data, index }: { data: typeof testimonials[0], index: number }) {
    const floatPatterns = [
        { y: [0, -6, 0], x: [0, 3, 0] },
        { y: [0, 5, 0], x: [0, -2, 0] },
        { y: [0, -4, 0], x: [0, -3, 0] },
        { y: [0, 6, 0], x: [0, 2, 0] },
    ];

    const pattern = floatPatterns[index % floatPatterns.length];

    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            animate={pattern}
            transition={{
                y: { duration: 4 + index * 0.5, repeat: Infinity, ease: "easeInOut" },
                x: { duration: 5 + index * 0.3, repeat: Infinity, ease: "easeInOut" },
            }}
            whileHover={{ scale: 1.02, y: -3 }}
            className="bg-zinc-900/50 backdrop-blur-xl border border-white/[0.05] p-6 rounded-2xl hover:border-expensee-neon/20 transition-colors duration-500 group cursor-pointer h-[200px] flex flex-col"
        >
            <div className="flex items-center gap-3 mb-4">
                <div className="relative flex-shrink-0">
                    <img src={data.image} alt={data.name} className="w-10 h-10 rounded-full border border-white/10" />
                    <div className="absolute -bottom-0.5 -right-0.5 bg-black rounded-full p-0.5">
                        {data.verified && (
                            <div className="w-3.5 h-3.5 rounded-full bg-blue-500 flex items-center justify-center">
                                <Check className="w-2 h-2 text-white" strokeWidth={4} />
                            </div>
                        )}
                    </div>
                </div>
                <div className="flex-1 min-w-0">
                    <span className="text-sm font-bold text-white block truncate">{data.name}</span>
                    <span className="text-[10px] text-zinc-500 font-medium uppercase tracking-wider">{data.handle}</span>
                </div>
                <Twitter className="w-4 h-4 text-zinc-700 group-hover:text-expensee-neon transition-colors flex-shrink-0" />
            </div>
            <p className="text-sm text-zinc-400 leading-relaxed line-clamp-4 flex-1">
                {data.text}
            </p>
        </motion.div>
    );
}
