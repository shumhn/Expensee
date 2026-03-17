"use client";

import Link from "next/link";
import { Twitter, Linkedin, ArrowUpRight } from "lucide-react";
import { Logo } from "@/components/Logo";

export function Footer() {
    return (
        <footer className="relative bg-black border-t border-white/5 py-12 md:py-24 px-6 overflow-hidden">
            <div className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-start gap-16">
                {/* Brand Section */}
                <div className="space-y-8 flex-1">
                    <div className="flex items-center gap-4">
                        <Logo className="w-16 h-16" />
                        <h2 className="text-3xl font-black uppercase tracking-[-0.02em] text-white">
                            Expensee
                        </h2>
                    </div>
                    <p className="text-zinc-500 text-lg font-medium max-w-sm leading-relaxed">
                        Private, real-time payroll streaming on Solana. FHE-encrypted salaries with MagicBlock TEE enclaves.
                    </p>
                </div>

                {/* Links Grid - Compact Right Aligned */}
                <div className="grid grid-cols-2 sm:grid-cols-2 gap-12 md:gap-16">
                    <FooterColumn
                        title="Platform"
                        links={[
                            { label: "Employer Portal", href: "https://onyx-fii.vercel.app/" },
                            { label: "Employee Portal", href: "https://onyx-fii.vercel.app/" },
                            { label: "Devnet App", href: "https://onyx-fii.vercel.app/" }
                        ]}
                    />
                    <FooterColumn
                        title="Resources"
                        links={[
                            { label: "Docs", href: "#" }
                        ]}
                    />
                </div>
            </div>

            {/* Bottom Bar */}
            <div className="max-w-7xl mx-auto mt-24 pt-8 border-t border-white/5 flex flex-col md:flex-row justify-between items-center gap-6 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-600">
                <div className="flex items-center gap-8">
                    <p>© 2026 Expensee Labs</p>
                    <p className="hidden md:block">The future of salary is private.</p>
                </div>

                <div className="flex items-center gap-6 cursor-default">
                    <a href="https://x.com/expensee_sol" target="_blank" rel="noopener noreferrer" className="hover:text-expensee-neon transition-colors">Twitter</a>
                    <a href="https://discord.com/" target="_blank" rel="noopener noreferrer" className="hover:text-expensee-neon transition-colors">Discord</a>
                    <a href="#" className="hover:text-expensee-neon transition-colors">Docs</a>
                </div>
            </div>
        </footer>
    );
}

function FooterColumn({ title, links }: { title: string, links: { label: string, href?: string }[] }) {
    return (
        <div className="flex flex-col gap-6">
            <h4 className="text-white text-xs font-black uppercase tracking-[0.2em]">
                {title}
            </h4>
            <div className="flex flex-col gap-4">
                {links.map((link, i) => (
                    link.href ? (
                        <Link
                            key={i}
                            href={link.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-zinc-500 hover:text-expensee-neon text-sm font-bold uppercase tracking-wider transition-colors duration-300"
                        >
                            {link.label}
                        </Link>
                    ) : (
                        <span
                            key={i}
                            className="text-zinc-500 hover:text-expensee-neon text-sm font-bold uppercase tracking-wider transition-colors duration-300 cursor-default"
                        >
                            {link.label}
                        </span>
                    )
                ))}
            </div>
        </div>
    );
}
