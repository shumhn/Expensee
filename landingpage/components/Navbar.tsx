"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Menu, X } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Logo } from "@/components/Logo";

export function Navbar() {
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

    return (
        <div className="fixed top-0 left-0 right-0 z-50 flex flex-col">

            <nav className="flex items-center justify-between px-6 lg:px-12 py-4 backdrop-blur-md bg-black/10 border-b border-white/5 w-full">
                <div className="flex items-center gap-2 lg:gap-3">
                    <Link href="/" className="flex items-center gap-3 group">
                        <Logo className="w-10 h-10 group-hover:scale-110 transition-transform duration-300" />
                        <span className="text-xl font-bold tracking-tighter uppercase text-white hover:text-expensee-neon transition-colors">
                            Expensee
                        </span>
                    </Link>
                </div>

                {/* Desktop Navigation */}
                <div className="hidden md:flex items-center gap-8 text-[13px] font-medium tracking-wide text-neutral-500">
                    <span className="hover:text-white transition-colors duration-200 cursor-default">
                        Features
                    </span>
                    <span className="hover:text-white transition-colors duration-200 cursor-default">
                        Pricing
                    </span>
                    <Link
                        href="#"
                        className="hover:text-white transition-colors duration-200"
                    >
                        Documentation
                    </Link>
                </div>

                <div className="flex items-center gap-4">
                    <Link
                        href="https://onyx-fii.vercel.app/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hidden sm:flex items-center gap-2 px-5 py-2 rounded-full border border-white/20 bg-transparent text-sm font-medium text-white hover:bg-white/10 transition-all duration-300 group"
                    >
                        Start Payroll
                        <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
                    </Link>

                    {/* Mobile Menu Toggle */}
                    <button
                        onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
                        className="md:hidden p-2 text-white hover:text-expensee-neon transition-colors"
                    >
                        {isMobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
                    </button>
                </div>

                {/* Mobile Menu Overlay */}
                <AnimatePresence>
                    {isMobileMenuOpen && (
                        <motion.div
                            initial={{ opacity: 0, y: -20 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -20 }}
                            transition={{ duration: 0.2 }}
                            className="absolute top-full left-0 right-0 bg-black border-b border-white/10 p-6 md:hidden flex flex-col gap-6 shadow-2xl"
                        >
                            <div className="flex flex-col gap-4 text-center">
                                <span className="text-lg font-medium text-zinc-400 hover:text-white transition-colors py-2 cursor-default">
                                    About
                                </span>
                                <span className="text-lg font-medium text-zinc-400 hover:text-white transition-colors py-2 cursor-default">
                                    Agents
                                </span>
                                <Link
                                    href="#"
                                    className="text-lg font-medium text-zinc-400 hover:text-white transition-colors py-2"
                                >
                                    Documentation
                                </Link>
                            </div>

                        </motion.div>
                    )}
                </AnimatePresence>
            </nav>
        </div>
    );
}
