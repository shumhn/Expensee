"use client";

import { motion } from "framer-motion";
import { Shield, Zap, Database, Check } from "lucide-react";

const features = [
    {
        title: "Instant Settlement",
        description: "Real-time salary accrual and on-chain payouts, every second.",
        icon: Zap
    },
    {
        title: "Privacy by Default",
        description: "FHE-encrypted salaries — only the employee sees their pay.",
        icon: Shield
    },
    {
        title: "Global Coverage",
        description: "Pay contractors in 50+ countries with USDC on Solana.",
        icon: Database
    }
];

const plans = [
    {
        name: "Starter",
        description: "Small Teams & Founders",
        price: "Free",
        features: ["5 Employees", "Real-time Accrual", "USDC Payouts"],
        color: "zinc"
    },
    {
        name: "Growth",
        description: "Growing Organizations",
        price: "$99",
        features: ["Unlimited Employees", "FHE Privacy", "Stealth Addresses"],
        color: "teal"
    },
    {
        name: "Enterprise",
        description: "Global Enterprises",
        price: "Custom",
        features: ["Dedicated Keeper", "Multi-sig Treasury", "Compliance Reports"],
        color: "purple"
    }
];

export function CompareCards() {
    return (
        <section className="py-32 px-6 bg-black relative">
            <div className="max-w-7xl mx-auto space-y-16">
                {/* Section Header */}
                <div className="flex items-center justify-between border-b border-white/10 pb-4">
                    <h3 className="text-zinc-500 text-xs font-bold uppercase tracking-[0.3em]">
                        Standard Options
                    </h3>
                    <div className="flex gap-2">
                        <div className="w-8 h-8 rounded-full bg-zinc-900 border border-white/10 flex items-center justify-center">
                            <Shield className="w-4 h-4 text-zinc-500" />
                        </div>
                        <div className="w-8 h-8 rounded-full bg-expensee-neon/20 border border-expensee-neon/30 flex items-center justify-center">
                            <Zap className="w-4 h-4 text-expensee-neon" />
                        </div>
                    </div>
                </div>

                <div className="flex flex-col lg:flex-row gap-16">
                    {/* Left: Features & CTA */}
                    <div className="lg:w-1/3 space-y-12">
                        <div className="space-y-8">
                            {features.map((feature, i) => (
                                <motion.div
                                    key={i}
                                    initial={{ opacity: 0, x: -20 }}
                                    whileInView={{ opacity: 1, x: 0 }}
                                    transition={{ delay: i * 0.1 }}
                                    className="flex gap-4"
                                >
                                    <div className="mt-1">
                                        <feature.icon className="w-5 h-5 text-expensee-neon" />
                                    </div>
                                    <div className="space-y-1">
                                        <h4 className="text-white font-bold text-sm uppercase tracking-wide">
                                            {feature.title}
                                        </h4>
                                        <p className="text-zinc-500 text-sm leading-relaxed">
                                            {feature.description}
                                        </p>
                                    </div>
                                </motion.div>
                            ))}
                        </div>

                        <button className="bg-white text-black px-8 py-3 rounded-full font-bold text-sm uppercase tracking-widest hover:bg-expensee-neon transition-colors duration-300">
                            Get started for Free
                        </button>
                    </div>

                    {/* Right: Plans Grid */}
                    <div className="flex-1 grid grid-cols-1 md:grid-cols-3 gap-6">
                        {plans.map((plan, i) => (
                            <PlanCard key={i} plan={plan} index={i} />
                        ))}
                    </div>
                </div>
            </div>
        </section>
    );
}

function PlanCard({ plan, index }: { plan: typeof plans[0], index: number }) {
    const isTeal = plan.color === "teal";
    const isPurple = plan.color === "purple";

    return (
        <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.1 }}
            className={`relative group h-[400px] overflow-hidden rounded-3xl border ${isPrimary ? 'border-expensee-primary/30 bg-expensee-primary/[0.02]' : isPurple ? 'border-purple-500/30 bg-purple-500/[0.02]' : 'border-white/10 bg-white/[0.01]'}`}
        >
            {/* Holographic background effects */}
            <div className={`absolute inset-0 bg-gradient-to-br transition-opacity duration-700 opacity-20 group-hover:opacity-40
                ${isPrimary ? 'from-expensee-primary/20 via-transparent to-transparent' :
                    isPurple ? 'from-purple-500/20 via-transparent to-transparent' :
                        'from-zinc-500/10 via-transparent to-transparent'}`}
            />

            <div className="relative p-8 h-full flex flex-col justify-between z-10">
                <div className="space-y-4">
                    <div className="flex items-center justify-between">
                        <div className={`p-2 rounded-lg border ${isTeal ? 'border-expensee-neon/50' : isPurple ? 'border-purple-500/50' : 'border-zinc-700'}`}>
                            <Shield className={`w-5 h-5 ${isTeal ? 'text-expensee-neon' : isPurple ? 'text-purple-400' : 'text-zinc-500'}`} />
                        </div>
                        <span className={`text-[10px] font-black uppercase tracking-[0.2em] px-2 py-1 rounded border
                            ${isTeal ? 'border-expensee-neon/40 text-expensee-neon' : isPurple ? 'border-purple-500/40 text-purple-400' : 'border-zinc-800 text-zinc-500'}`}>
                            {plan.price}
                        </span>
                    </div>

                    <div>
                        <h3 className="text-2xl font-black italic uppercase tracking-tighter text-white">
                            {plan.name}
                        </h3>
                        <p className={`text-xs font-bold uppercase tracking-widest ${isTeal ? 'text-expensee-neon/60' : isPurple ? 'text-purple-400/60' : 'text-zinc-600'}`}>
                            {plan.description}
                        </p>
                    </div>
                </div>

                <div className="space-y-4">
                    <div className="h-px w-full bg-white/10" />
                    <ul className="space-y-3">
                        {plan.features.map((feature, i) => (
                            <li key={i} className="flex items-center gap-2">
                                <Check className={`w-3 h-3 ${isTeal ? 'text-expensee-neon' : isPurple ? 'text-purple-400' : 'text-zinc-500'}`} />
                                <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-400">
                                    {feature}
                                </span>
                            </li>
                        ))}
                    </ul>
                </div>
            </div>

            {/* Shine effect */}
            <div className="absolute inset-0 bg-gradient-to-tr from-transparent via-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
        </motion.div>
    );
}
