"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Logo } from "@/components/Logo";

export function Navbar() {
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
                </div>
            </nav>
        </div>
    );
}
