"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, Minus } from "lucide-react";

const faqs = [
    {
        question: "How is my salary kept private?",
        answer: "Expensee uses Fully Homomorphic Encryption (FHE) via Inco Lightning. This means your salary rate and accrued balance are stored as encrypted handles on-chain. Nobody—not even the nodes running the network—can see the actual dollar amounts."
    },
    {
        question: "What is 'Ghost Mode' withdrawal?",
        answer: "Ghost Mode allows employees to withdraw funds without linking their wallet address to their employee index on-chain. You sign an off-chain message that the Expensee Keeper relays, keeping your identity hidden from public blockchain explorers."
    },
    {
        question: "How does real-time streaming work?",
        answer: "We leverage MagicBlock TEEs (Trusted Execution Environments). Your salary accrues every second in a secure off-chain enclave, which then periodically commits the encrypted state back to the Solana L1."
    },
    {
        question: "Can I use Expensee for my team today?",
        answer: "Expensee is currently live on Solana Devnet. You can register your business, fund your vault with devnet USDC, and start streaming to your team immediately to experience the future of private payroll."
    },
    {
        question: "Is the protocol audited?",
        answer: "The Expensee core protocol architecture is built on top of audited primitives from Inco and MagicBlock. Our custom Keeper and settlement logic are designed with multi-layer failovers for production-grade reliability."
    },
];

export function FAQ() {
    const [openIndex, setOpenIndex] = useState<number | null>(0);

    return (
        <section className="py-24 px-6 bg-black border-t border-white/5">
            <div className="max-w-7xl mx-auto">
                <div className="flex flex-col lg:flex-row gap-16 lg:gap-24">
                    {/* Left Side - Title */}
                    <motion.div
                        className="lg:w-[300px] flex-shrink-0"
                        initial={{ opacity: 0, x: -30 }}
                        whileInView={{ opacity: 1, x: 0 }}
                        viewport={{ once: true }}
                    >
                        <h2 className="text-5xl md:text-6xl lg:text-7xl font-light italic tracking-tight text-white">
                            FAQS
                        </h2>
                    </motion.div>

                    {/* Right Side - Accordion */}
                    <div className="flex-1 space-y-0">
                        {faqs.map((faq, index) => (
                            <FAQItem
                                key={index}
                                question={faq.question}
                                answer={faq.answer}
                                isOpen={openIndex === index}
                                onToggle={() => setOpenIndex(openIndex === index ? null : index)}
                                index={index}
                            />
                        ))}
                    </div>
                </div>
            </div>
        </section>
    );
}

function FAQItem({
    question,
    answer,
    isOpen,
    onToggle,
    index
}: {
    question: string;
    answer: string;
    isOpen: boolean;
    onToggle: () => void;
    index: number;
}) {
    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: index * 0.05 }}
            className="border-t border-white/10 last:border-b"
        >
            <button
                onClick={onToggle}
                className="w-full py-6 flex items-center justify-between gap-4 text-left group"
            >
                <span className="text-lg md:text-xl font-medium text-white group-hover:text-expensee-neon transition-colors">
                    {question}
                </span>
                <div className="flex-shrink-0 w-8 h-8 flex items-center justify-center transition-colors">
                    {isOpen ? (
                        <Minus className="w-5 h-5 text-white/50 group-hover:text-expensee-neon transition-colors" />
                    ) : (
                        <Plus className="w-5 h-5 text-white/50 group-hover:text-expensee-neon transition-colors" />
                    )}
                </div>
            </button>

            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.3, ease: [0.23, 1, 0.32, 1] }}
                        className="overflow-hidden"
                    >
                        <div className="pb-8 pr-12">
                            <p className="text-zinc-400 text-lg leading-relaxed whitespace-pre-line max-w-2xl">
                                {answer}
                            </p>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.div>
    );
}
